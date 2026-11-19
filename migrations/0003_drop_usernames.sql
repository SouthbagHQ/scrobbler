-- Custom usernames are rolled back: the username is the Southbag Identity handle again.
DROP INDEX IF EXISTS users_username_unique;
ALTER TABLE users DROP COLUMN username;
