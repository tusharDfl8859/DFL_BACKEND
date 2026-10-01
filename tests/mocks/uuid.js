module.exports = {
    v4: () => 'test-uuid-' + Math.floor(Math.random() * 1000000),
    validate: () => true,
    parse: () => { },
    stringify: () => { }
};
