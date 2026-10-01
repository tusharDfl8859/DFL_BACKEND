const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const extractTrackingId = async (buffer, mimeType) => {
    try {
        let text = '';
        if (mimeType === 'application/pdf') {
            try {
                const data = await pdfParse(buffer);
                text = data.text;
            } catch (err) {
                return null;
            }
        } else if (mimeType.startsWith('image/')) {
            try {
                const { data: { text: ocrText } } = await Tesseract.recognize(buffer, 'eng');
                text = ocrText;
            } catch (err) {
                return null;
            }
        } else {
            return null;
        }

        const cleanText = text.replace(/\s+/g, ' ');
        const uspsRegex = /(9[2345]\d{20,24})/;
        const upsRegex = /(1Z[A-Z0-9]{16})/i;
        const fedexRegex = /(\d{12})/;
        const genericRegex = /(\d{10,30})/;

        let match = cleanText.match(uspsRegex) ||
            cleanText.match(upsRegex) ||
            cleanText.match(fedexRegex) ||
            cleanText.match(genericRegex);

        if (match) {
            return match[0];
        }

        return null;

    } catch (error) {
        return null;
    }
};

module.exports = { extractTrackingId };
