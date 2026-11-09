CREATE TABLE urls (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  visit_count INTEGER NOT NULL,
  last_visit_time INTEGER NOT NULL
);

INSERT INTO urls VALUES (1, 'https://work.example.test/tools?view=recent#now', 'Work tools', 15, 13437576000000000);
INSERT INTO urls VALUES (2, 'https://private.example.test/account?access_token=secret', 'Private account', 25, 13437600000000000);
INSERT INTO urls VALUES (3, 'https://code.example.test/projects/atum', 'Project Atum', 4, 13436928000000000);
INSERT INTO urls VALUES (4, 'https://old.example.test/archive', 'Old Chrome page', 30, 13424745600000000);
INSERT INTO urls VALUES (5, 'https://id.example.test/verify/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtaW5oIn0.xQqN3LJd7f0fBgKx5Qs2gQ', 'Verify', 50, 13437599000000000);
INSERT INTO urls VALUES (6, 'https://id.example.test/invite/AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'Invite', 50, 13437598000000000);
INSERT INTO urls VALUES (7, 'https://id.example.test/reset/ZyXwVuTsRqPoNmLkJiHgFeDcBa987654', 'Reset', 50, 13437597000000000);
INSERT INTO urls VALUES (8, 'https://files.example.test/share/abc123def456abc123def456abc123', 'Share', 50, 13437596000000000);
INSERT INTO urls VALUES (9, 'https://bucket.s3.example.test/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=private&X-Amz-Signature=0123456789abcdef0123456789abcdef', 'Report', 50, 13437595000000000);
INSERT INTO urls VALUES (10, 'https://app.example.test/callback#access_token=private', 'Callback', 50, 13437594000000000);
INSERT INTO urls VALUES (11, 'https://app.example.test/callback?code=private', 'Callback', 50, 13437593000000000);
INSERT INTO urls VALUES (12, 'https://docs.example.test/editor', 'VS Code tips', 2, 13437570000000000);
INSERT INTO urls VALUES (13, 'https://travel.example.test/guide', 'Passport guide', 3, 13437565000000000);
INSERT INTO urls VALUES (14, 'https://account.example.test/help', 'Reset password', 60, 13437592000000000);
INSERT INTO urls VALUES (15, 'https://files.example.test/download/0123456789abcdef0123456789abcdef', 'Download', 50, 13437591000000000);
INSERT INTO urls VALUES (16, 'https://id.example.test/p/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtaW5oIn0.xQqN3LJd7f0fBgKx5Qs2gQ', 'Account', 50, 13437590000000000);
