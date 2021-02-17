const { promisify } = require('util');

const EventEmitter = require('events');

const BufferList = require('bl');

const { varint } = require('protocol-buffers-encodings');

const UnableToParseRequestError = require('./errors/UnableToParseRequestError');
const ResponseExceptionError = require('./errors/ResponseExceptionError');
const MaxRequestSizeError = require('./errors/MaxRequestSizeError');

const {
  tendermint: {
    abci: {
      Request,
      Response,
    },
  },
} = require('../types.js');

class Connection extends EventEmitter {
  /**
   * @param {Socket} socket
   * @param {Function} handleRequest
   */
  constructor(socket, handleRequest) {
    super();

    this.socket = socket;
    this.handleRequest = handleRequest;
    this.readerBuffer = new BufferList();
    this.isReadingRequest = false;

    this.writeAndFlush = promisify(this.socket.write.bind(socket));

    this.socket.on('data', (data) => {
      this.readerBuffer.append(data);

      // noinspection JSIgnoredPromiseFromCall
      this.readNextRequest();
    });
  }

  /**
   * Write response to socket
   *
   * @param {Response} response
   * @param {boolean} [forceFlush=false]
   * @return {Promise<boolean>}
   */
  async write(response, forceFlush = false) {
    const responseBuffer = Response.encode(response).finish();
    const responseLengthBuffer = Buffer.from(
      // eslint-disable-next-line no-bitwise
      varint.encode(responseBuffer.length << 1),
    );

    // Write to memory
    this.socket.cork();

    try {
      this.socket.write(responseLengthBuffer);

      if (forceFlush) {
        await this.writeAndFlush(responseBuffer);
      } else {
        this.socket.write(responseBuffer);
      }
    } finally {
      this.socket.uncork();
    }
  }

  /**
   * @private
   * @return {Promise<void>}
   */
  async readNextRequest() {
    if (this.isReadingRequest) {
      return;
    }

    this.isReadingRequest = true;

    let request;

    // Parse request
    try {
      // eslint-disable-next-line no-bitwise
      const requestLength = varint.decode(this.readerBuffer.slice(0, 8)) >> 1;
      const varintLength = varint.decode.bytes;

      if (requestLength > Connection.MAX_MESSAGE_SIZE) {
        this.socket.destroy(new MaxRequestSizeError(Connection.MAX_MESSAGE_SIZE));

        return;
      }

      if (varintLength + requestLength > this.readerBuffer.length) {
        // buffering message, don't read yet
        this.isReadingRequest = false;

        return;
      }

      const messageBytes = this.readerBuffer.slice(
        varintLength,
        varintLength + requestLength,
      );

      this.readerBuffer.consume(varintLength + requestLength);

      request = Request.decode(messageBytes);
    } catch (e) {
      const error = new UnableToParseRequestError(e, this.readerBuffer);

      this.socket.destroy(error);

      return;
    }

    // Handle request
    let response;
    try {
      // Do not read new data from socket since we handling request
      this.socket.pause();

      response = await this.handleRequest(request);

      this.socket.resume();
    } catch (handlerError) {
      if (handlerError instanceof ResponseExceptionError) {
        let emitError;

        try {
          await this.write(handlerError.getResponse());
        } catch (writeError) {
          emitError = writeError;
        }

        // Do not emit connection error if write is successful
        this.socket.destroy(emitError);

        return;
      }

      throw handlerError;
    }

    // Write response
    const forceFlush = Boolean(response.flush);

    try {
      await this.write(response, forceFlush);
    } catch (e) {
      this.socket.destroy(e);

      return;
    }

    this.isReadingRequest = false;

    // Read more requests if available
    if (this.readerBuffer.length > 0) {
      // noinspection JSIgnoredPromiseFromCall,ES6MissingAwait
      this.readNextRequest();
    }
  }
}

Connection.MAX_MESSAGE_SIZE = 104857600; // 100mb;

module.exports = Connection;
