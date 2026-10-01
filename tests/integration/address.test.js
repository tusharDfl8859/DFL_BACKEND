const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../../server');
const User = require('../../models/User');
const Address = require('../../models/Address');

describe('Address API Integration', () => {
    const makeUser = (suffix) => ({
        name: `Address User ${suffix}`,
        email: `address-user-${suffix}-${Date.now()}@example.com`,
        phone: '1234567890',
        password: 'password123',
        accountType: 'personal'
    });

    const sampleAddress = {
        name: 'Home',
        companyName: 'DFL',
        contact: {
            mobileNumber: '9999999999',
            emailAddress: 'home@example.com'
        },
        address: {
            addressLine: '123 Main Street',
            city: 'Noida',
            state: 'Uttar Pradesh',
            country: 'India',
            pincode: '201301'
        },
        alternateContact: {
            name: 'Alt Contact',
            mobileNumber: '8888888888'
        }
    };

    const createAuthUser = async (suffix) => {
        const userData = makeUser(suffix);
        const user = await User.create({
            ...userData,
            customerId: `DFLC-${Date.now()}-${suffix}`
        });

        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });

        return { user, token };
    };

    it('rejects unauthenticated access to address routes', async () => {
        const res = await request(app).get('/api/addresses/someone');
        expect(res.statusCode).toBe(401);
    });

    it('creates and lists only the authenticated user addresses', async () => {
        const { user, token } = await createAuthUser('primary');

        const createRes = await request(app)
            .post('/api/addresses')
            .set('Authorization', `Bearer ${token}`)
            .send({
                customerID: 'spoofed-customer-id',
                ...sampleAddress
            });

        expect(createRes.statusCode).toBe(201);
        expect(createRes.body.customerID).toBe(user.customerId);

        const listRes = await request(app)
            .get(`/api/addresses/${user.customerId}`)
            .set('Authorization', `Bearer ${token}`);

        expect(listRes.statusCode).toBe(200);
        expect(Array.isArray(listRes.body)).toBe(true);
        expect(listRes.body).toHaveLength(1);
        expect(listRes.body[0].customerID).toBe(user.customerId);
    });

    it('prevents cross-user access for update and delete', async () => {
        const first = await createAuthUser('first');
        const second = await createAuthUser('second');

        const createRes = await request(app)
            .post('/api/addresses')
            .set('Authorization', `Bearer ${first.token}`)
            .send(sampleAddress);

        const addressId = createRes.body._id;

        const updateRes = await request(app)
            .put(`/api/addresses/${addressId}`)
            .set('Authorization', `Bearer ${second.token}`)
            .send({
                name: 'Hacked',
                customerID: second.user.customerId,
                isDefault: true
            });

        expect(updateRes.statusCode).toBe(404);

        const deleteRes = await request(app)
            .delete(`/api/addresses/${addressId}`)
            .set('Authorization', `Bearer ${second.token}`);

        expect(deleteRes.statusCode).toBe(404);
    });

    it('ignores protected fields during address updates', async () => {
        const { user, token } = await createAuthUser('update');

        const createRes = await request(app)
            .post('/api/addresses')
            .set('Authorization', `Bearer ${token}`)
            .send(sampleAddress);

        const addressId = createRes.body._id;

        const updateRes = await request(app)
            .put(`/api/addresses/${addressId}`)
            .set('Authorization', `Bearer ${token}`)
            .send({
                name: 'Updated Home',
                customerID: 'tampered-id',
                savedAddressId: 'tampered-saved-id',
                isDefault: true
            });

        expect(updateRes.statusCode).toBe(200);
        expect(updateRes.body.name).toBe('Updated Home');
        expect(updateRes.body.customerID).toBe(user.customerId);
        expect(updateRes.body.savedAddressId).not.toBe('tampered-saved-id');
    });
});
