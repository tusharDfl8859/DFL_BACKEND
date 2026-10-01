const mongoose = require('mongoose');

describe('Backend Testing Infrastructure', () => {
    it('should connect to the in-memory database', async () => {
        // 1 = connected
        expect(mongoose.connection.readyState).toBe(1);
    });

    it('should start with an empty database', async () => {
        const collections = mongoose.connection.collections;
        for (const key in collections) {
            const collection = collections[key];
            const count = await collection.countDocuments();
            expect(count).toBe(0);
        }
    });

    it('should allow writing and reading from the in-memory database', async () => {
        // Create a temporary schema/model just for this test
        const TestSchema = new mongoose.Schema({ name: String });
        const TestModel = mongoose.model('Test', TestSchema);

        // Write
        await TestModel.create({ name: 'Jest' });

        // Read
        const found = await TestModel.findOne({ name: 'Jest' });
        expect(found).toBeDefined();
        expect(found.name).toBe('Jest');
    });
});
