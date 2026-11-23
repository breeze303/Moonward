CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false, image text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE account (id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ON DELETE CASCADE, "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, scope text, password text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX account_user ON account("userId");
CREATE TABLE session (id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES "user" ON DELETE CASCADE);
CREATE INDEX session_by_user ON session("userId");
CREATE TABLE verification (id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX verification_identifier ON verification(identifier);
CREATE TABLE profiles (id text PRIMARY KEY REFERENCES "user" ON DELETE CASCADE, role text NOT NULL CHECK(role IN ('admin','user')),
  disabled integer NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)), daily_limit integer NOT NULL CHECK(daily_limit>=0), last_served bigint NOT NULL DEFAULT 0);
CREATE SEQUENCE dispatch_order;
CREATE TABLE invitations (token_hash text PRIMARY KEY, email text NOT NULL, expires_at bigint NOT NULL, redeemed_at bigint, created_by text NOT NULL REFERENCES profiles);
CREATE INDEX invitations_email ON invitations(email);
CREATE TABLE site_settings (id integer PRIMARY KEY CHECK(id=1), daily_limit integer NOT NULL CHECK(daily_limit>=0),
  running_limit integer NOT NULL DEFAULT 100 CHECK(running_limit BETWEEN 1 AND 1000), waiting_limit integer NOT NULL DEFAULT 200 CHECK(waiting_limit BETWEEN 0 AND 10000));
CREATE TABLE chats (id text PRIMARY KEY, owner_id text NOT NULL REFERENCES profiles ON DELETE CASCADE, title text NOT NULL,
  version integer NOT NULL DEFAULT 0, leaf_id text, updated_at bigint NOT NULL, title_job_until bigint NOT NULL DEFAULT 0);
CREATE INDEX chats_owner ON chats(owner_id,updated_at DESC);
CREATE TABLE messages (id text PRIMARY KEY, chat_id text NOT NULL REFERENCES chats ON DELETE CASCADE, parent_id text, role text NOT NULL CHECK(role IN ('user','assistant')),
  content text NOT NULL, status text NOT NULL, error text, model text, citations text NOT NULL DEFAULT '[]', thinking text,
  ordinal bigint GENERATED ALWAYS AS IDENTITY, UNIQUE(chat_id,id), FOREIGN KEY(chat_id,parent_id) REFERENCES messages(chat_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED);
ALTER TABLE chats ADD FOREIGN KEY(id,leaf_id) REFERENCES messages(chat_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX messages_order ON messages(chat_id,ordinal);
CREATE TABLE attachments (id text PRIMARY KEY, chat_id text NOT NULL REFERENCES chats ON DELETE CASCADE, name text NOT NULL,
  mime text NOT NULL, size integer NOT NULL, bytes bytea NOT NULL CHECK(octet_length(bytes)=size));
CREATE INDEX attachments_chat ON attachments(chat_id);
CREATE TABLE message_attachments (message_id text NOT NULL REFERENCES messages ON DELETE CASCADE, attachment_id text NOT NULL REFERENCES attachments ON DELETE CASCADE,
  position integer NOT NULL, PRIMARY KEY(message_id,position));
CREATE INDEX message_attachments_file ON message_attachments(attachment_id);
CREATE TABLE attempts (id text PRIMARY KEY, owner_id text NOT NULL REFERENCES profiles ON DELETE CASCADE, chat_id text REFERENCES chats ON DELETE SET NULL,
  assistant_id text REFERENCES messages ON DELETE SET NULL, day text NOT NULL, status text NOT NULL, model text NOT NULL, input_tokens integer, output_tokens integer);
CREATE INDEX attempts_owner_day ON attempts(owner_id,day);
CREATE INDEX attempts_day ON attempts(day);
CREATE UNIQUE INDEX one_active_run ON attempts(chat_id) WHERE status IN ('queued','streaming');
CREATE TABLE gateway_settings (id integer PRIMARY KEY CHECK(id=1), version integer NOT NULL, base_url text NOT NULL, encrypted_key text);
CREATE TABLE model_catalog (id integer PRIMARY KEY CHECK(id=1), version integer NOT NULL, selection text);
CREATE TABLE generation_jobs (id text PRIMARY KEY REFERENCES attempts ON DELETE CASCADE, effort text, web integer NOT NULL CHECK(web IN (0,1)), summary integer NOT NULL CHECK(summary IN (0,1)),
  worker_id text, lease_until timestamptz, stop_reason text CHECK(stop_reason IN ('stopped','disabled')), output_tokens integer NOT NULL, context_chars integer NOT NULL,
  ordinal bigint GENERATED ALWAYS AS IDENTITY, last_seq integer NOT NULL DEFAULT 0, CHECK((worker_id IS NULL)=(lease_until IS NULL)));
CREATE INDEX jobs_waiting ON generation_jobs(ordinal) WHERE worker_id IS NULL;
-- Keep a short-lived running title reservation even when its chat is renamed or deleted.
-- No text or credentials are stored here. Pending work is validated against the chat before use.
CREATE TABLE title_jobs (chat_id text PRIMARY KEY, model text NOT NULL, output_tokens integer NOT NULL,
  gateway_version integer NOT NULL, ordinal bigint GENERATED ALWAYS AS IDENTITY, until_ms bigint);
CREATE INDEX title_jobs_waiting ON title_jobs(ordinal) WHERE until_ms IS NULL;
CREATE TABLE run_chunks (run_id text NOT NULL REFERENCES attempts ON DELETE CASCADE, seq integer NOT NULL, delta text NOT NULL, thinking text,
  PRIMARY KEY(run_id,seq));

-- A new text-only chat has no branch history or attachment replay to validate.
-- Keep its admission, quota reservation and four inserts in one database round trip.
CREATE FUNCTION submit_first(p_owner text,p_chat text,p_version integer,p_gateway integer,p_text text,p_title text,
  p_model text,p_effort text,p_web integer,p_summary integer,p_output integer,p_context integer,p_day text,
  p_run text,p_user text,p_reply text,p_now bigint) RETURNS text LANGUAGE plpgsql AS $$
DECLARE limits site_settings; person profiles; topic chats;
BEGIN
  SELECT * INTO limits FROM site_settings WHERE id=1 FOR UPDATE;
  SELECT * INTO topic FROM chats WHERE id=p_chat AND owner_id=p_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF topic.version<>p_version THEN RETURN 'conflict'; END IF;
  IF topic.leaf_id IS NOT NULL THEN RETURN 'history'; END IF;
  SELECT * INTO person FROM profiles WHERE id=p_owner;
  IF NOT FOUND OR person.disabled<>0 THEN RETURN 'disabled'; END IF;
  IF NOT EXISTS(SELECT FROM gateway_settings WHERE version=p_gateway) THEN RETURN 'gateway_conflict'; END IF;
  IF (SELECT count(*) FROM generation_jobs)+(SELECT count(*) FROM title_jobs WHERE until_ms>extract(epoch FROM clock_timestamp())*1000)>=limits.running_limit+limits.waiting_limit THEN RETURN 'queue_full'; END IF;
  IF (SELECT count(*) FROM attempts WHERE day=p_day AND owner_id=p_owner)>=person.daily_limit THEN RETURN 'user_limit'; END IF;
  IF (SELECT count(*) FROM attempts WHERE day=p_day)>=limits.daily_limit THEN RETURN 'site_limit'; END IF;
  INSERT INTO messages(id,chat_id,parent_id,role,content,status,model) VALUES
    (p_user,p_chat,NULL,'user',p_text,'completed',NULL),(p_reply,p_chat,p_user,'assistant','','queued',p_model);
  INSERT INTO attempts(id,owner_id,chat_id,assistant_id,day,status,model) VALUES(p_run,p_owner,p_chat,p_reply,p_day,'queued',p_model);
  INSERT INTO generation_jobs(id,effort,web,summary,output_tokens,context_chars) VALUES(p_run,p_effort,p_web,p_summary,p_output,p_context);
  UPDATE chats SET title=CASE WHEN title='' THEN p_title ELSE title END,leaf_id=p_reply,version=version+1,updated_at=p_now WHERE id=p_chat;
  RETURN 'ok:'||coalesce(nullif(topic.title,''),p_title);
END $$;

CREATE TYPE first_input AS (owner_id text,chat_id text,version integer,gateway integer,body text,title text,
  model text,effort text,web integer,summary integer,output_tokens integer,context_chars integer,day text,
  run_id text,user_id text,reply_id text,submitted bigint);

-- Common case: independent first turns with enough quota can be inserted as sets.
-- A mixed/conflicting batch takes the ordered single-row path with identical semantics.
CREATE FUNCTION submit_batch(payload jsonb) RETURNS TABLE(n bigint,result text) LANGUAGE plpgsql AS $$
DECLARE items first_input[]; limits site_settings; locked integer; cnt integer; ready boolean;
BEGIN
  SELECT array_agg(ROW(j->>0,j->>1,(j->>2)::int,(j->>3)::int,j->>4,j->>5,j->>6,j->>7,
    (j->>8)::int,(j->>9)::int,(j->>10)::int,(j->>11)::int,j->>12,j->>13,j->>14,j->>15,(j->>16)::bigint)::first_input ORDER BY ord)
    INTO items FROM jsonb_array_elements(payload) WITH ORDINALITY AS src(j,ord);
  cnt:=cardinality(items);
  SELECT * INTO STRICT limits FROM site_settings WHERE id=1 FOR UPDATE;
  PERFORM c.id FROM chats c JOIN unnest(items) r ON r.owner_id=c.owner_id AND r.chat_id=c.id
    WHERE c.version=r.version AND c.leaf_id IS NULL ORDER BY c.id FOR UPDATE OF c;
  GET DIAGNOSTICS locked=ROW_COUNT;
  ready:=locked=cnt AND (SELECT count(DISTINCT chat_id) FROM unnest(items))=cnt;
  IF ready THEN
    SELECT NOT EXISTS(SELECT FROM unnest(items) r WHERE NOT EXISTS(SELECT FROM gateway_settings g WHERE g.version=r.gateway))
      AND (SELECT count(*) FROM generation_jobs)+(SELECT count(*) FROM title_jobs WHERE until_ms>extract(epoch FROM clock_timestamp())*1000)+cnt<=limits.running_limit+limits.waiting_limit
      AND NOT EXISTS(SELECT FROM (SELECT day,count(*) AS needed FROM unnest(items) GROUP BY day) d
        WHERE (SELECT count(*) FROM attempts a WHERE a.day=d.day)+d.needed>limits.daily_limit)
      AND NOT EXISTS(SELECT FROM (SELECT owner_id,day,count(*) AS needed FROM unnest(items) GROUP BY owner_id,day) d
        LEFT JOIN profiles p ON p.id=d.owner_id WHERE p.id IS NULL OR p.disabled<>0 OR
        (SELECT count(*) FROM attempts a WHERE a.day=d.day AND a.owner_id=d.owner_id)+d.needed>p.daily_limit) INTO ready;
  END IF;
  IF NOT ready THEN
    RETURN QUERY SELECT r.ordinality,submit_first(r.owner_id,r.chat_id,r.version,r.gateway,r.body,r.title,r.model,r.effort,
      r.web,r.summary,r.output_tokens,r.context_chars,r.day,r.run_id,r.user_id,r.reply_id,r.submitted)
      FROM unnest(items) WITH ORDINALITY r ORDER BY r.ordinality;
    RETURN;
  END IF;
  INSERT INTO messages(id,chat_id,parent_id,role,content,status,model)
    SELECT user_id,chat_id,NULL,'user',body,'completed',NULL FROM unnest(items)
    UNION ALL SELECT reply_id,chat_id,user_id,'assistant','','queued',model FROM unnest(items);
  INSERT INTO attempts(id,owner_id,chat_id,assistant_id,day,status,model)
    SELECT run_id,owner_id,chat_id,reply_id,day,'queued',model FROM unnest(items);
  INSERT INTO generation_jobs(id,effort,web,summary,output_tokens,context_chars)
    SELECT run_id,effort,web,summary,output_tokens,context_chars FROM unnest(items) WITH ORDINALITY r ORDER BY r.ordinality;
  UPDATE chats c SET title=coalesce(nullif(c.title,''),r.title),leaf_id=r.reply_id,version=c.version+1,updated_at=r.submitted
    FROM unnest(items) r WHERE c.id=r.chat_id;
  RETURN QUERY SELECT r.ordinality,'ok:'||c.title FROM unnest(items) WITH ORDINALITY r JOIN chats c ON c.id=r.chat_id ORDER BY r.ordinality;
END $$;
