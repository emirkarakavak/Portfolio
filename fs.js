const fs = require('fs').promises;
const https = require('https');
const { URL } = require('url');

function getWithRedirect(u, { timeoutMs = 30000, maxRedirects = 5, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(u);
    const opts = {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (crawler; oyuneks)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
        ...headers,
      },
    };

    const req = https.request(urlObj, opts, (res) => {
      // Redirect?
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); // body boşalt
        if (maxRedirects <= 0) return reject(new Error('Max redirects aşıldı'));
        const next = new URL(res.headers.location, urlObj).toString();
        return resolve(getWithRedirect(next, { timeoutMs, maxRedirects: maxRedirects - 1, headers }));
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });

    req.on('error', reject);
    req.end();
  });
}

async function downloadXml(url, outPath, { retries = 2, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const buf = await getWithRedirect(url, { timeoutMs });
      await fs.writeFile(outPath, buf);
      const size = buf.length.toLocaleString('tr-TR');
      console.log(`✓ kaydedildi: ${outPath} (${size} bayt)`);
      return;
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        const backoff = 800 * (i + 1);
        console.warn(`deneme ${i + 1} hata: ${e.message || e}. ${backoff}ms sonra tekrar denenecek`);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}
// Çalıştırma (dosya direkt çağrılırsa)
if (require.main === module) {
  const URL_ = 'https://oyuneks.com/feed.xml';
  const OUT_ = './oyuneks.xml';

  downloadXml(URL_, OUT_, { retries: 2, timeoutMs: 30000 })
    .catch(err => {
      console.error('✗ indirilemedi:', err?.message || err);
      process.exitCode = 1;
    });
}

// Modül olarak da kullanmak istersen:
module.exports = { downloadXml };
