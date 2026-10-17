// The native module doesn't exist under Jest; every suite gets the
// package's in-memory mock automatically (node_modules-adjacent __mocks__).
module.exports = require("@react-native-async-storage/async-storage/jest/async-storage-mock");
