const MAX_HEADER_SIZE = 16*1024;

class Server {

  constructor(args) {
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
    const reader = conn.getReadableStream().getReader();

    let headerText = "";
    let bodyStart = "";

    let totalBytesRead = 0;

    while (!haveHeaders) {
      const { value, done } = await reader.read();

      totalBytesRead += value.length;
      if (totalBytesRead > MAX_HEADER_SIZE) {
        throw new Error("Headers too big");
      }

      console.log(value, done);
      const text = this._decoder.decode(value);

      const parts = text.split("\r\n\r\n");
      headerText += parts[0];

      console.log(parts);

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

    console.log(method, path, proto, headers, bodyStart);

    const request = {
      method,
      url: {
        path,
      },
      header: headers,
      proto,
      // TODO: release reader
      body: conn.getReadableStream(),
    };

    const responseWriter = new ResponseWriter(conn.getWritableStream());

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
    const callback = this._map[r.url.path];
    if (callback !== undefined) {
      await callback(w, r);
      await w._writer.close();
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

    // TODO: feels brittle. also we should be able to switch back and worth
    // between manual writing and piping
    this._writer = null;

    return this._writable;
  }
}

export {
  Server,
  ServeMux,
};
