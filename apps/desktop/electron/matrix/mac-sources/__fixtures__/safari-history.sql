CREATE TABLE history_items (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  visit_count INTEGER NOT NULL
);
CREATE TABLE history_visits (
  id INTEGER PRIMARY KEY,
  history_item INTEGER NOT NULL,
  visit_time REAL NOT NULL
);

INSERT INTO history_items VALUES (1, 'https://docs.example.test/research?q=atum#section', 'Research notes', 8);
INSERT INTO history_items VALUES (2, 'https://bank.example.test/login?session=secret', 'Bank login', 12);
INSERT INTO history_items VALUES (3, 'https://example.test/oauth/token', 'Authentication token', 2);
INSERT INTO history_items VALUES (4, 'https://old.example.test/archive', 'Old page', 20);
INSERT INTO history_visits VALUES (1, 1, 814795200);
INSERT INTO history_visits VALUES (2, 2, 814802400);
INSERT INTO history_visits VALUES (3, 3, 814809600);
INSERT INTO history_visits VALUES (4, 4, 801964800);
