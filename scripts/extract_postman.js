const fs = require('fs');
const https = require('https');

const url = 'https://documenter.gw.postman.com/api/collections/1566816/2sA2xfYt8W?segregateAuth=true&versionTag=latest';

https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const collection = JSON.parse(data);
            const endpoints = [];

            function extractRequests(items) {
                if (!items || !Array.isArray(items)) return;
                for (const item of items) {
                    if (item.item) {
                        extractRequests(item.item);
                    } else if (item.request) {
                        endpoints.push({
                            name: item.name,
                            method: item.request.method,
                            url: typeof item.request.url === 'object' ? item.request.url.raw : item.request.url,
                            body: item.request.body ? item.request.body.raw : null
                        });
                    }
                }
            }

            // Postman API sometimes returns the collection directly, sometimes wrapped
            const rootItems = collection.collection ? collection.collection.item : collection.item;
            extractRequests(rootItems);
            
            fs.writeFileSync('tpl_api_dump.json', JSON.stringify(endpoints, null, 2));
            console.log('Saved ' + endpoints.length + ' endpoints to tpl_api_dump.json');
        } catch (err) {
            console.error(err);
        }
    });
});
