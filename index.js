const MAX_HEADER_SIZE = 16 * 1024;
const HEADER_TERMINATOR = new Uint8Array([13, 10, 13, 10]);

class Request {
  constructor(uri, opts) {
    this._uri = uri;
    this._opts = opts;
  }

  get body() {
    return this._opts.body;
  }

  get headers() {
    return new Headers(this._opts.headers);
  }

  get method() {
    return this._opts.method;
  }

  get url() {
    return this._uri;
  }
}

class Server {
  constructor() {
    this._encoder = new TextEncoder();
    this._decoder = new TextDecoder('utf-8');
  }

  async serve(listener, callback) {
    this._domain = listener.getDomain();
    const connStreamReader = listener.connectionStream.getReader();

    while (true) {
      const { value: conn, done } = await connStreamReader.read();
      if (done) {
        break;
      }

      this.handleConn(conn, callback).catch((error) => {
        console.error('http-js connection error:', error);
      });
    }
  }

  async handleConn(conn, callback) {
    const reader = conn.readable.getReader();
    const { headerBytes, bodyStart } = await readHeaders(reader);
    const headerText = this._decoder.decode(headerBytes);
    const headerLines = headerText.split('\r\n');

    const requestLine = headerLines.shift().split(' ');
    if (requestLine.length !== 3) {
      throw new Error('Invalid HTTP request line');
    }
    const [method, path] = requestLine;

    /** @type {HeadersInit} */
    const headers = {};
    for (const header of headerLines) {
      const separator = header.indexOf(':');
      if (separator < 1) {
        throw new Error('Invalid HTTP header');
      }
      const name = header.slice(0, separator).trim().toLowerCase();
      const value = header.slice(separator + 1).trim();
      headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
    }

    const contentLength = parseContentLength(headers['content-length']);
    const body = contentLength > 0
      ? requestBody(reader, bodyStart, contentLength)
      : null;

    const request = new Request(`https://${this._domain}${path}`, {
      method,
      headers,
      body,
    });

    const response = await callback(request);
    if (!(response instanceof Response)) {
      throw new Error('HTTP handler must return a Response');
    }

    await this._sendResponse(conn, response, method === 'HEAD');
  }

  async _sendResponse(conn, response, omitBody) {
    const statusText = response.statusText || defaultStatusText(response.status);
    let headerText = `HTTP/1.1 ${response.status} ${statusText}\r\n`;

    for (const [name, value] of response.headers.entries()) {
      headerText += `${name}: ${value}\r\n`;
    }
    headerText += 'Connection: close\r\n\r\n';

    const writer = conn.writable.getWriter();
    await writer.write(this._encoder.encode(headerText));
    writer.releaseLock();

    if (!omitBody && response.body !== null) {
      await response.body.pipeTo(conn.writable);
    }
    else {
      const closeWriter = conn.writable.getWriter();
      await closeWriter.close();
    }
  }
}

async function readHeaders(reader) {
  let buffered = new Uint8Array(0);

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error('Connection closed before HTTP headers finished');
    }

    const next = new Uint8Array(buffered.byteLength + value.byteLength);
    next.set(buffered);
    next.set(value, buffered.byteLength);
    buffered = next;

    const headerEnd = indexOf(buffered, HEADER_TERMINATOR);
    if (headerEnd >= 0) {
      return {
        headerBytes: buffered.slice(0, headerEnd),
        bodyStart: buffered.slice(headerEnd + HEADER_TERMINATOR.byteLength),
      };
    }

    if (buffered.byteLength > MAX_HEADER_SIZE) {
      throw new Error('HTTP headers too large');
    }
  }
}

function requestBody(reader, firstChunk, contentLength) {
  let bytesRead = 0;
  let pending = firstChunk;

  return new ReadableStream({
    async pull(controller) {
      if (bytesRead >= contentLength) {
        controller.close();
        return;
      }

      let chunk;
      if (pending.byteLength > 0) {
        chunk = pending;
        pending = new Uint8Array(0);
      }
      else {
        const result = await reader.read();
        if (result.done) {
          controller.error(new Error('Connection closed before HTTP body finished'));
          return;
        }
        chunk = result.value;
      }

      const remaining = contentLength - bytesRead;
      if (chunk.byteLength > remaining) {
        chunk = chunk.slice(0, remaining);
      }
      bytesRead += chunk.byteLength;
      controller.enqueue(chunk);

      if (bytesRead >= contentLength) {
        controller.close();
      }
    },
  });
}

function directoryTreeHandler(dirTree, opt) {
  return async (request) => {
    const url = new URL(request.url);

    let file;
    try {
      file = await dirTree.openFile(url.pathname);
    }
    catch {
      return new Response('Not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    let sendFile = file;
    let statusCode = 200;
    const headers = { ...((opt && opt.headers) || {}) };

    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      let range;
      try {
        range = parseRangeHeader(rangeHeader, file.size);
      }
      catch {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${file.size}` },
        });
      }

      sendFile = file.slice(range.start, range.end + 1);
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.size}`;
      statusCode = 206;
    }

    headers['Accept-Ranges'] = 'bytes';
    headers['Content-Type'] = file.type || 'application/octet-stream';
    headers['Content-Length'] = String(sendFile.size);

    return new Response(sendFile.stream(), {
      status: statusCode,
      headers,
    });
  };
}

function parseRangeHeader(headerText, maxSize) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(headerText.trim());
  if (!match || maxSize <= 0 || (!match[1] && !match[2])) {
    throw new Error('Invalid range');
  }

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new Error('Invalid range');
    }
    start = Math.max(0, maxSize - suffixLength);
    end = maxSize - 1;
  }
  else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : maxSize - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || start >= maxSize || end < start) {
    throw new Error('Invalid range');
  }

  return { start, end: Math.min(end, maxSize - 1) };
}

function parseContentLength(value) {
  if (value === undefined) {
    return 0;
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error('Invalid Content-Length');
  }
  return length;
}

function indexOf(haystack, needle) {
  outer: for (let i = 0; i <= haystack.byteLength - needle.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

function defaultStatusText(status) {
  const statuses = {
    200: 'OK',
    206: 'Partial Content',
    400: 'Bad Request',
    404: 'Not Found',
    416: 'Range Not Satisfiable',
    500: 'Internal Server Error',
  };
  return statuses[status] || '';
}

export {
  Server,
  parseRangeHeader,
  directoryTreeHandler,
};
