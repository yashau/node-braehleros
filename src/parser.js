'use strict';

class Parser {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  readInt32() {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readInt64() {
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }

  readString() {
    const n = this.readInt32();
    if (n <= 0) return '';
    const s = this.buf.toString('utf16le', this.pos, this.pos + n * 2);
    this.pos += n * 2;
    return s;
  }

  skipInt(n = 1)    { this.pos += n * 4; }
  skipLong(n = 1)   { this.pos += n * 8; }
  skipString(n = 1) { for (let i = 0; i < n; i++) this.readString(); }

  // VirtualTable metadata header: String*4 + Int32 + String
  skipHeader() {
    this.skipString(4);
    this.skipInt();
    this.skipString();
  }
}

module.exports = Parser;
