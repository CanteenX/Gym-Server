import jwt from "jsonwebtoken";

export const generateToken = (_id, role) => {
  return jwt.sign(
    { id: _id, role: role },
    process.env[`${role.toUpperCase()}_JWT_SECRET_KEY`],
    { expiresIn: process.env.JWT_EXPIRY },
  );
};
