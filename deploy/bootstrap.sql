\set ON_ERROR_STOP on
\getenv app_password APP_DB_PASSWORD
BEGIN;
CREATE ROLE moonward_app LOGIN PASSWORD :'app_password';
REVOKE ALL ON DATABASE moonward FROM PUBLIC;
GRANT CONNECT ON DATABASE moonward TO moonward_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
\i /opt/moonward/schema.sql
\i /opt/moonward/memory-v1.sql
INSERT INTO site_settings(id,daily_limit) VALUES (1,200);
INSERT INTO gateway_settings VALUES (1,0,'https://api.openai.com/v1',NULL);
INSERT INTO model_catalog VALUES (1,0,'{"models":[],"defaultId":null}');
GRANT USAGE ON SCHEMA public TO moonward_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO moonward_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO moonward_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO moonward_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO moonward_app;
COMMIT;
