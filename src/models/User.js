/**
 * src/models/User.js
 * ---------------------------------------------------------------------
 * 用户模型 —— 注册 / 登录的数据基础。
 *
 * 安全要点：
 *  1. 密码【绝不存明文】：保存前用 bcrypt 加盐哈希（pre-save 钩子）。
 *  2. password 字段 select:false，默认查询不会带出密码，
 *     只有登录时显式 .select('+password') 才能取到。
 *  3. email 唯一索引，防止重复注册（唯一约束在数据库层兜底）。
 */
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
  {
    // 邮箱：统一转小写、去首尾空格，作为唯一登录凭证
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    // 密码（哈希后的密文）。select:false = 默认查询不返回此字段
    password: { type: String, required: true, minlength: 8, select: false },

    // 昵称（可选）
    name: { type: String, default: '' },

    // 角色：基础版仅区分 user/admin；
    // 💎 PRO 专享：企业级 RBAC 在此扩展为「角色 + 权限点 + 租户」多维模型
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    versionKey: false,
  }
);

// 保存前钩子：密码字段被修改时才重新哈希（避免更新其它字段时二次哈希）
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// 校验密码：比对明文候选值与库中哈希
userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

// 转为可安全返回给前端的对象（剔除密码）
userSchema.methods.toSafeJSON = function () {
  return {
    id: this._id.toString(),
    email: this.email,
    name: this.name,
    role: this.role,
    createdAt: this.createdAt,
  };
};

// 复用已注册的模型，避免 nodemon 热重载时触发 OverwriteModelError
export default mongoose.models.User || mongoose.model('User', userSchema);
