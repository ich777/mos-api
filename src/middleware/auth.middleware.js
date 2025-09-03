const jwt = require('jsonwebtoken');
const fs = require('fs').promises;
const path = require('path');

const BOOT_TOKEN_PATH = '/boot/config/api/token';

const getBootToken = async () => {
  try {
    const token = await fs.readFile(BOOT_TOKEN_PATH, 'utf8');
    const trimmedToken = token.trim();
    return trimmedToken.length > 0 ? trimmedToken : null;
  } catch (error) {
    return null;
  }
};

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. Token required.' });
  }

  try {
    // Check if it's the boot token
    const bootToken = await getBootToken();
    if (bootToken && token === bootToken) {
      req.user = { role: 'admin', isBootToken: true };
      return next();
    }

    // Check if it's an admin API token
    const userService = require('../services/user.service');
    const adminTokenData = await userService.validateAdminToken(token);
    if (adminTokenData) {
      req.user = adminTokenData;
      return next();
    }

    // Regular JWT verification
    const decodedUser = jwt.verify(token, process.env.JWT_SECRET);

    // Check if user still exists
    const users = await userService.loadUsers();
    const currentUser = users.find(u => u.id === decodedUser.id);

    if (!currentUser) {
      return res.status(403).json({ error: 'User no longer exists.' });
    }

    // samba_only users are not allowed to access the API
    if (currentUser.role === 'samba_only') {
      return res.status(403).json({
        error: 'Access denied. This account is for file sharing only.'
      });
    }

    // Check if role has changed
    if (currentUser.role !== decodedUser.role) {
      return res.status(403).json({
        error: 'Token invalid due to role change. Please login again.'
      });
    }

    // Use current user data instead of token data
    req.user = {
      id: currentUser.id,
      username: currentUser.username,
      role: currentUser.role
    };

    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }
};

const checkRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    // Boot token and admin tokens always have full access
    if (req.user.isBootToken || req.user.isAdminToken) {
      return next();
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions for this action.' });
    }

    next();
  };
};

module.exports = {
  authenticateToken,
  checkRole,
  getBootToken
}; 