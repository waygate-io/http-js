const MAX_HEADER_SIZE = 16*1024;

class Server {

  constructor(args) {

    this._domain = args.domain;
    this._handler = args.handler;
    this._encoder = new TextEncoder();
    this._decoder = new TextDecoder('utf-8');
  }

  async serve(listener, callback) {
    while (true) {

      let conn;

      try {
        conn = await listener.accept();
      }
      catch (e) {
        throw e;
      }
      
      this.handleConn(conn, callback);
    }
  }

  async handleConn(conn, callback) {
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

    /** @type {HeadersInit} */
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

    const response = await callback(request);

    await this._sendResponse(conn, response);

    return null;
  }

  async _sendResponse(conn, res) {
    let headerText = `HTTP/1.1 ${res.status}\r\n`;

    for (const pair of res.headers.entries()) {
      headerText += `${pair[0]}: ${pair[1]}\r\n`;
    }

    headerText += `\r\n`;

    const headers = this._encoder.encode(headerText);

    const writer = conn.writable.getWriter();

    await writer.write(headers);
    writer.releaseLock();

    try {
      await res.body.pipeTo(conn.writable);
    }
    catch (e) {
      //console.error("http-js error: res.body.pipeTo", e);
    }

    // TODO: might need to close here
    //await writer.close();

    return null;
  }
}

function directoryTreeHandler(dirTree) {
  return async (r) => {
    const url = new URL(r.url);

    let file;
    try {
      file = await dirTree.openFile(url.pathname);
    }
    catch (e) {
      return new Response("Not found", {
        status: 404,
      });
    }

    let sendFile = file;
    const contentType = file.type;

    let statusCode = 200;

    /** @type {HeadersInit} */
    const headers = {};

    if (r.headers.get('range')) {
      const range = parseRangeHeader(r.headers.get('range'));

      if (range.end !== undefined) {
        sendFile = file.slice(range.start, range.end + 1);
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.size}`;
      }
      else {
        sendFile = file.slice(range.start);
        headers['Content-Range'] = `bytes ${range.start}-${file.size - 1}/${file.size}`;
      }

      statusCode = 206;
    }

    headers['Accept-Ranges'] = 'bytes';
    headers['Content-Type'] = contentType;
    headers['Content-Length'] = sendFile.size;

    return new Response(sendFile.stream(), {
      status: statusCode,
      headers,
    });
  };
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
  parseRangeHeader,
  directoryTreeHandler,
};
