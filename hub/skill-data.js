'use strict';
/** Per-skill encrypted data stores, created lazily on first use. */
const { SecureStore } = require('./secure-store');

const stores = {};
function storeFor(skillName) {
  if (!stores[skillName]) stores[skillName] = new SecureStore('skill-' + skillName);
  return stores[skillName];
}

module.exports = { storeFor };
