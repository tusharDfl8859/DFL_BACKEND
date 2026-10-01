const crypto = require('crypto');

const makePublicId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

module.exports = { makePublicId };
