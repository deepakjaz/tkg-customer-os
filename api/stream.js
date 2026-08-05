/**
 * Vercel API Route: /api/stream.js
 * FIXED: Uses native stream piping instead of arrayBuffer buffering
 * Properly handles HTTP 206 Partial Content for mobile seeking
 * 
 * Usage: /api/stream?id=FILE_ID
 */

export default async function handler(req, res) {
  const { id } = req.query;
  
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid file ID' });
  }

  const driveUrl = `https://drive.google.com/uc?export=download&id=${id}`;

  try {
    // Build headers, passing through Range requests for 206 support
    const headers = {};
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    // Fetch from Google Drive
    const driveRes = await fetch(driveUrl, { headers });

    // Set response headers
    res.setHeader('Content-Type', driveRes.headers.get('content-type') || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Handle 206 Partial Content (byte-range requests)
    if (driveRes.status === 206 || driveRes.headers.get('content-range')) {
      res.setHeader('Content-Range', driveRes.headers.get('content-range'));
      res.setHeader('Content-Length', driveRes.headers.get('content-length'));
      res.status(206);
    } else {
      res.setHeader('Content-Length', driveRes.headers.get('content-length'));
      res.status(200);
    }

    // Stream piping (not buffering)
    if (driveRes.body?.pipe) {
      // Node.js streams available (most environments)
      driveRes.body.pipe(res);
    } else {
      // Fallback: ReadableStream (Edge runtime)
      const reader = driveRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        res.end();
      }
    }
  } catch (err) {
    console.error('Stream Proxy Error:', err);
    return res.status(500).json({ error: 'Streaming proxy error: ' + err.message });
  }
}
