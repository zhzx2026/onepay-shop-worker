-- 管理员改为普通账号上的角色；后台使用独立会话，不再使用全局管理员密码。
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);

-- 仅提升迁移时已存在的 zj 开头账号；新注册账号始终为普通用户，避免通过注册抢占后台权限。
UPDATE users SET role = 'admin' WHERE lower(email) LIKE 'zj%';

-- 废弃全局管理员密码，并使旧的伪管理员会话立即失效。
DELETE FROM settings WHERE key = 'admin_password_hash';
DELETE FROM sessions WHERE user_id = 'admin' OR role = 'admin';
