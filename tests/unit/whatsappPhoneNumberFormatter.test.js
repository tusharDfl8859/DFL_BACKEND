const { formatPhoneNumber, maskPhoneNumber } = require('../../utils/phoneNumberFormatter');

describe('WhatsApp phone number formatter', () => {
    test.each([
        ['9876543210', '91', '919876543210'],
        ['+91 98765 43210', '91', '919876543210'],
        ['91-98765-43210', '91', '919876543210'],
        ['(09876) 543-210', '91', '919876543210'],
        ['(987) 654-3210', '1', '19876543210'],
        ['0044 7700 900123', '91', '447700900123'],
    ])('formats %s into an international numeric value', (input, countryCode, expected) => {
        expect(formatPhoneNumber(input, countryCode)).toBe(expected);
    });

    test.each([null, undefined, '', '12345', '0000000000', 'not-a-phone-number'])('returns null for invalid input %p', (input) => {
        expect(formatPhoneNumber(input, '91')).toBeNull();
    });

    test('masks phone numbers before logging', () => {
        expect(maskPhoneNumber('919876543210')).toBe('9198******10');
    });

    test('rejects an invalid Indian mobile prefix', () => {
        expect(formatPhoneNumber('911234567890', '91')).toBeNull();
    });
});
