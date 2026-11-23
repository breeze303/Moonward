-- Applied once per database, in a transaction, by the database owner.
CREATE TABLE IF NOT EXISTS moonward_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO moonward_migrations(version) VALUES ('memory-v1');
ALTER TABLE profiles ADD COLUMN memory_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN memory_auto boolean NOT NULL DEFAULT false, ADD COLUMN memory_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN memory_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE site_settings ADD COLUMN memory_model text;
CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL REFERENCES profiles ON DELETE CASCADE,
  topic text NOT NULL, scope text NOT NULL DEFAULT '', body text NOT NULL CHECK(length(body) BETWEEN 1 AND 500),
  locked boolean NOT NULL, revision integer NOT NULL DEFAULT 1, changed timestamptz NOT NULL DEFAULT now(),
  source text REFERENCES messages ON DELETE SET NULL, prior jsonb, UNIQUE(owner_id,topic,scope));
CREATE TABLE memory_references (reply text REFERENCES messages ON DELETE CASCADE, memory uuid REFERENCES memories ON DELETE CASCADE,
  body text NOT NULL, PRIMARY KEY(reply,memory));
CREATE TABLE memory_jobs (source text PRIMARY KEY REFERENCES messages ON DELETE CASCADE, owner_id text NOT NULL REFERENCES profiles ON DELETE CASCADE,
  epoch bigint NOT NULL, model text NOT NULL, gateway integer NOT NULL, state text NOT NULL DEFAULT 'waiting', started timestamptz);
CREATE INDEX memory_jobs_pending ON memory_jobs(source) WHERE state='waiting';
CREATE FUNCTION memory_sensitive(s text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT
  s ~* '(sk-[a-z0-9_-]{8,}|gh[pousr]_|github_pat_|AKIA[A-Z0-9]{12}|-----BEGIN|eyJ[A-Za-z0-9_-]+\.|[a-z]+://[^ /]+:[^ /]+@|api[ _-]?key|secret|token|bearer|password|credential|密码|密钥|口令|验证码|身份证|银行卡|私钥|诊断|病史|[A-Z0-9_+/=-]{32,}|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[a-z]{2,}|[0-9]{9,})' $$;
CREATE FUNCTION memory_insert_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p profiles; explicit text; k text; area text; hit memories; cfg text;
BEGIN
  IF NEW.role <> 'user' OR NEW.content='' THEN RETURN NEW; END IF;
  SELECT u.* INTO p FROM profiles u JOIN chats c ON c.owner_id=u.id WHERE c.id=NEW.chat_id AND c.memory_enabled AND u.memory_enabled;
  IF NOT FOUND OR memory_sensitive(NEW.content) THEN RETURN NEW; END IF;
  explicit := trim(regexp_replace(NEW.content,'^\s*(请记住|记住|remember\s+that|remember)\s*[:：，,]?\s*','','i'));
  IF explicit <> trim(NEW.content) AND NEW.content ~* '^\s*(请?记住|remember\y)' THEN
    IF length(explicit) NOT BETWEEN 1 AND 500 THEN RETURN NEW; END IF;
    SELECT * INTO p FROM profiles WHERE id=p.id FOR UPDATE;
    IF NOT p.memory_enabled THEN RETURN NEW; END IF;
    area := CASE WHEN explicit ~* '(部署|deploy|compose|podman)' THEN '部署' WHEN explicit ~* '(数据库|database|postgres|mysql)' THEN '数据库' ELSE '' END;
    IF explicit ~ '^[a-zA-Z][a-zA-Z0-9_-]+\s*(的|项目|使用|用)' THEN area:=lower(substring(explicit from '^([a-zA-Z][a-zA-Z0-9_-]+)')); END IF;
    k := CASE WHEN explicit ~* '(数据库|database|postgres|mysql)' THEN 'database' WHEN explicit ~* '(部署|deploy|compose|podman)' THEN 'deployment' WHEN explicit ~ '(叫我|称呼)' THEN 'name' WHEN explicit ~ '(中文|英文|英语|汉语)' THEN 'language' ELSE md5(explicit) END;
    SELECT * INTO hit FROM memories WHERE owner_id=p.id AND topic=k AND scope=area;
    IF hit.id IS NULL AND (SELECT count(*) FROM memories WHERE owner_id=p.id)>=200 THEN RETURN NEW; END IF;
    INSERT INTO memories(owner_id,topic,scope,body,locked,source) VALUES(p.id,k,area,explicit,true,NEW.id)
      ON CONFLICT(owner_id,topic,scope) DO UPDATE SET prior=jsonb_build_object('body',memories.body,'locked',memories.locked,'source',memories.source),body=excluded.body,revision=memories.revision+1,source=excluded.source,changed=now(),locked=true;
    UPDATE profiles SET memory_epoch=memory_epoch+1 WHERE id=p.id;
  ELSIF p.memory_auto AND length(NEW.content)<=1200 AND NEW.content ~* '(我|我们|以后|偏好|默认|习惯|项目|\y(I|my|we|our|prefer|always)\y)' AND NEW.content !~* '(这次|临时|假设|引用|```|https?://|别人说|一次性|this time|hypothetical|suppose|[“”「」<>])' THEN
    SELECT memory_model INTO cfg FROM site_settings WHERE id=1;
    IF cfg IS NOT NULL THEN INSERT INTO memory_jobs(source,owner_id,epoch,model,gateway) SELECT NEW.id,p.id,p.memory_epoch,cfg,version FROM gateway_settings; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_new_message AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION memory_insert_message();
