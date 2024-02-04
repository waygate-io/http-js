const MAX_HEADER_SIZE = 16*1024;

class Server {

  constructor(args) {
    this._domain = args.domain;
    this._handler = args.handler;
    this._decoder = new TextDecoder('utf-8');
  }

  async serve(listener) {
    while (true) {

      let conn;

      try {
        conn = await listener.accept();
      }
      catch (e) {
        throw e;
      }
      
      this.handleConn(conn);
    }
  }

  async handleConn(conn) {
    let haveHeaders = false;

    // TODO: unlock stream after parsing headers
    const reader = conn.readable.getReader();

    let headerText = "";
    let bodyStart = "";

    let totalBytesRead = 0;

    while (!haveHeaders) {
      const { value, done } = await reader.read();

      totalBytesRead += value.length;
      if (totalBytesRead > MAX_HEADER_SIZE) {
        throw new Error("Headers too big");
      }

      const text = this._decoder.decode(value);

      const parts = text.split("\r\n\r\n");
      headerText += parts[0];

      if (parts.length > 1) {
        bodyStart = parts[1];
        break;
      }
    }

    const headerLines = headerText.split("\r\n");

    const statusLine = headerLines[0];

    const statusParts = statusLine.split(" ");
    const method = statusParts[0];
    const path = statusParts[1];
    const proto = statusParts[2];

    const headers = {};
    for (const header of headerLines.slice(1)) {
      const headerParts = header.split(":");
      headers[headerParts[0].trim().toLowerCase()] = headerParts[1].trim();
    }

    let body = null;
    if (method !== 'HEAD' && method !== 'GET') {
      body = conn.readable;
    }

    let uri = `https://${this._domain}${path}`;

    const request = new Request(uri, {
      method,
      headers,
      body,
    });

    const responseWriter = new ResponseWriter(conn.writable);

    this._handler.serveHTTP(responseWriter, request);
  }
}

class ServeMux {
  constructor() {
    this._map = {};
  }

  handleFunc(path, callback) {
    this._map[path] = callback;
  }

  async serveHTTP(w, r) {

    console.log(r.url);

    let u = new URL(r.url);

    for (const path in this._map) {
      if (u.pathname.startsWith(path)) {
        const callback = this._map[path];
        await callback(w, r);
        if (w._writer) {
          await w._writer.close();
        }
        break;
      }
    }
  }
}

class ResponseWriter {
  constructor(writable) {
    this.headers = {};

    this._writable = writable;

    this._writer = writable.getWriter();

    this._encoder = new TextEncoder('utf-8');

    this._headersSent = false;
  }

  async writeHeader(statusCode) {

    let headerText = `HTTP/1.1 ${statusCode}\r\n`;

    for (const key in this.headers) {
      headerText += `${key}: ${this.headers[key]}\r\n`;
    }

    headerText += `\r\n`;

    const headers = this._encoder.encode(headerText);

    await this._writer.write(headers);

    this._headersSent = true;
  }

  async write(data) {
    if (!this._headersSent) {
      await this.writeHeader(200);
    }
    return this._writer.write(data);
  }

  async getWritableStream() {
    if (!this._headersSent) {
      await this.writeHeader(200);
    }

    if (this._writable.locked) {
      this._writer.releaseLock();
    }

    // TODO: feels brittle. also we should be able to switch back and forth
    // between manual writing and piping
    this._writer = null;

    return this._writable;
  }
}

function parseRangeHeader(headerText, maxSize) {
  const range = {};
  const right = headerText.split('=')[1];
  const rangeParts = right.split('-');
  range.start = Number(rangeParts[0]);
  //range.end = maxSize - 1;

  if (rangeParts[1]) {
    range.end = Number(rangeParts[1]);
  }

  return range;
}

export {
  Server,
  ServeMux,
  parseRangeHeader,
};
