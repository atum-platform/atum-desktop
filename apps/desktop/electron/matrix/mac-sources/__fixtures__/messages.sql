CREATE TABLE chat (
  ROWID INTEGER PRIMARY KEY,
  display_name TEXT,
  chat_identifier TEXT
);
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL);
CREATE TABLE chat_handle_join (chat_id INTEGER NOT NULL, handle_id INTEGER NOT NULL);
CREATE TABLE message (
  ROWID INTEGER PRIMARY KEY,
  text TEXT,
  attributedBody BLOB,
  is_from_me INTEGER NOT NULL,
  date INTEGER NOT NULL,
  handle_id INTEGER
);
CREATE TABLE chat_message_join (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL);
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, mime_type TEXT);
CREATE TABLE message_attachment_join (message_id INTEGER NOT NULL, attachment_id INTEGER NOT NULL);

INSERT INTO chat VALUES (1, 'Family plans', 'chat-family');
INSERT INTO chat VALUES (2, NULL, '+12025550102');
INSERT INTO handle VALUES (1, '+12025550103');
INSERT INTO handle VALUES (2, 'friend@example.test');
INSERT INTO chat_handle_join VALUES (1, 1);
INSERT INTO chat_handle_join VALUES (1, 2);
INSERT INTO chat_handle_join VALUES (2, 1);

INSERT INTO message VALUES (1, 'Dinner Sunday at 7. Address 123 Main Street. Call +12025550103 or see https://example.test/plan?token=nope#part', NULL, 0, 814795200000000000, 1);
INSERT INTO message VALUES (2, 'Sounds good', NULL, 1, 814798800000000000, NULL);
INSERT INTO message VALUES (3, 'Your verification code is 123456', NULL, 0, 814802400000000000, 1);
INSERT INTO message VALUES (4, NULL, X'62706C6973743030', 0, 814806000000000000, 2);
INSERT INTO message VALUES (5, NULL, NULL, 0, 814809600000000000, 1);
INSERT INTO message VALUES (6, 'Old context', NULL, 0, 801964800000000000, 1);
INSERT INTO message VALUES (7, 'A separate recent note', NULL, 0, 814795200000000000, 1);

INSERT INTO chat_message_join VALUES (1, 1);
INSERT INTO chat_message_join VALUES (1, 2);
INSERT INTO chat_message_join VALUES (1, 3);
INSERT INTO chat_message_join VALUES (1, 4);
INSERT INTO chat_message_join VALUES (1, 5);
INSERT INTO chat_message_join VALUES (1, 6);
INSERT INTO chat_message_join VALUES (2, 7);
INSERT INTO attachment VALUES (1, 'image/jpeg');
INSERT INTO message_attachment_join VALUES (5, 1);

-- Hostile privacy fixtures live on a synthetic chat id that is not part of conversation metadata.
INSERT INTO message VALUES (100, 'G-123456', NULL, 0, 814810000000000000, 1);
INSERT INTO message VALUES (101, '123 456', NULL, 0, 814810001000000000, 1);
INSERT INTO message VALUES (102, '123-456', NULL, 0, 814810002000000000, 1);
INSERT INTO message VALUES (103, 'Mã OTP của bạn là 123456', NULL, 0, 814810003000000000, 1);
INSERT INTO message VALUES (104, 'Your code: 4 8 2 9 1 7', NULL, 0, 814810004000000000, 1);
INSERT INTO message VALUES (105, 'Call 090.123.4567.', NULL, 0, 814810005000000000, 1);
INSERT INTO message VALUES (106, 'Call +84 90 123 4567.', NULL, 0, 814810006000000000, 1);
INSERT INTO message VALUES (107, 'Call (028) 3823 4567.', NULL, 0, 814810007000000000, 1);
INSERT INTO message VALUES (108, 'Call 090/123/4567.', NULL, 0, 814810008000000000, 1);
INSERT INTO message VALUES (109, 'Meet at 123 Nguyen Trai, District 1.', NULL, 0, 814810009000000000, 1);
INSERT INTO message VALUES (110, 'Office: 45 Lê Lợi, Q.1.', NULL, 0, 814810010000000000, 1);
INSERT INTO message VALUES (111, 'Cafe: 12/3 Nguyễn Huệ.', NULL, 0, 814810011000000000, 1);
INSERT INTO message VALUES (112, 'Open https://id.example.test/verify/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtaW5oIn0.xQqN3LJd7f0fBgKx5Qs2gQ', NULL, 0, 814810012000000000, 1);
INSERT INTO message VALUES (113, 'Open https://id.example.test/invite/AbCdEfGhIjKlMnOpQrStUvWxYz012345', NULL, 0, 814810013000000000, 1);
INSERT INTO message VALUES (114, 'Open https://id.example.test/reset/ZyXwVuTsRqPoNmLkJiHgFeDcBa987654', NULL, 0, 814810014000000000, 1);
INSERT INTO message VALUES (115, 'Open https://files.example.test/share/abc123def456abc123def456abc123', NULL, 0, 814810015000000000, 1);
INSERT INTO message VALUES (116, 'Open https://bucket.s3.example.test/report.pdf?X-Amz-Credential=private&X-Amz-Signature=0123456789abcdef0123456789abcdef', NULL, 0, 814810016000000000, 1);
INSERT INTO message VALUES (117, 'Open https://app.example.test/callback#access_token=private', NULL, 0, 814810017000000000, 1);
INSERT INTO message VALUES (118, 'Open https://app.example.test/callback?code=private', NULL, 0, 814810018000000000, 1);
INSERT INTO message VALUES (119, 'Open https://files.example.test/download/0123456789abcdef0123456789abcdef', NULL, 0, 814810019000000000, 1);
INSERT INTO message VALUES (120, 'Open https://id.example.test/p/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtaW5oIn0.xQqN3LJd7f0fBgKx5Qs2gQ', NULL, 0, 814810020000000000, 1);

INSERT INTO chat_message_join VALUES (99, 100);
INSERT INTO chat_message_join VALUES (99, 101);
INSERT INTO chat_message_join VALUES (99, 102);
INSERT INTO chat_message_join VALUES (99, 103);
INSERT INTO chat_message_join VALUES (99, 104);
INSERT INTO chat_message_join VALUES (99, 105);
INSERT INTO chat_message_join VALUES (99, 106);
INSERT INTO chat_message_join VALUES (99, 107);
INSERT INTO chat_message_join VALUES (99, 108);
INSERT INTO chat_message_join VALUES (99, 109);
INSERT INTO chat_message_join VALUES (99, 110);
INSERT INTO chat_message_join VALUES (99, 111);
INSERT INTO chat_message_join VALUES (99, 112);
INSERT INTO chat_message_join VALUES (99, 113);
INSERT INTO chat_message_join VALUES (99, 114);
INSERT INTO chat_message_join VALUES (99, 115);
INSERT INTO chat_message_join VALUES (99, 116);
INSERT INTO chat_message_join VALUES (99, 117);
INSERT INTO chat_message_join VALUES (99, 118);
INSERT INTO chat_message_join VALUES (99, 119);
INSERT INTO chat_message_join VALUES (99, 120);
