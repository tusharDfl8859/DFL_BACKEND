const fs = require('fs');
const path = require('path');

describe('Google Site Verification Meta Tag Verification', () => {
    let indexHtmlContent = null;
    const indexPath = path.resolve(__dirname, '../../../Frontend/index.html');
    const hasFrontend = fs.existsSync(indexPath);

    beforeAll(() => {
        if (hasFrontend) {
            indexHtmlContent = fs.readFileSync(indexPath, 'utf8');
        }
    });

    test('Frontend/index.html should exist if Frontend directory is present', () => {
        if (!hasFrontend) {
            console.log('[SiteVerification] Skipped: Frontend repository is segregated from Backend');
            return;
        }
        expect(indexHtmlContent).toBeDefined();
        expect(indexHtmlContent.length).toBeGreaterThan(0);
    });

    test('Frontend/index.html should contain google-site-verification meta tag', () => {
        if (!hasFrontend) return;
        expect(indexHtmlContent).toContain('<meta name="google-site-verification"');
    });

    test('google-site-verification meta tag should have the exact verification token', () => {
        if (!hasFrontend) return;
        const expectedTag = '<meta name="google-site-verification" content="Qe6MY-9YHJqI8RD2HMdBRVSQJpPWJo508NZxXA8wWX8" />';
        expect(indexHtmlContent).toContain(expectedTag);
    });

    test('google-site-verification tag should be located inside the <head> element', () => {
        if (!hasFrontend) return;
        const headStart = indexHtmlContent.indexOf('<head>');
        const headEnd = indexHtmlContent.indexOf('</head>');
        const tagIndex = indexHtmlContent.indexOf('google-site-verification');

        expect(headStart).toBeLessThan(tagIndex);
        expect(tagIndex).toBeLessThan(headEnd);
    });
});
