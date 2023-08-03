import { createHash } from 'crypto';
import { createServer } from 'http';

const PORT = 1337;
// value defined by the protocol, it's universal
const WEBSOCKET_MAGIC_STRING_KEY = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SEVEN_BITS_INTEGER_MARKER = 125;
const SIXTEEN_BITS_INTEGER_MARKER = 126;
const SIXTYFOUR_BITS_INTEGER_MARKER = 127;

const MAXIMUM_SIXTEEN_BITS_INTEGER = 2 ** 16; // 0 to 65536
const MASK_KEY_BYTES_LENGTH = 4;
const OPCODE_TEXT = 0x01;

// parseInt('10000000', 2);
const FIRST_BIT = 128;

const server = createServer((request, response) => {
	response.writeHead(200);
	response.end('hey');
}).listen(PORT, () => console.log('server listening to', PORT));

server.on('upgrade', onSocketUpgrade);

function onSocketUpgrade(req, socket, head) {
	const { 'sec-websocket-key': webClientSocketKey } = req.headers;

	console.log(`${webClientSocketKey} connected!`);

	const headers = prepareHandshakeHeaders(webClientSocketKey);
	console.log({ headers });

	socket.write(headers);
	socket.on('readable', () => onSocketReadable(socket));
}

function sendMessage(message, socket) {
	const dataFrameBuffer = prepareMessage(message);
	socket.write(dataFrameBuffer);
}

function prepareMessage(message) {
	const messageBuffer = Buffer.from(message);
	const messageSize = message.length;

	let dataFrameBuffer;

	// 0x80 === 128 in binary
	// '0x' + Math.abs(128).toString(16) == 0x80
	const firstByte = 0x80 | OPCODE_TEXT; // single frame + text

	// asserting the message isn't bigger than the browser limit, that is represented by the constant below
	if (messageSize <= SEVEN_BITS_INTEGER_MARKER) {
		const bytes = [firstByte];
		dataFrameBuffer = Buffer.from(bytes.concat(messageSize));
	} else if (messageSize <= MAXIMUM_SIXTEEN_BITS_INTEGER) {
		const offsetFourBytes = 4;
		const target = Buffer.allocUnsafe(offsetFourBytes);
		target[0] = firstByte;
		target[1] = SIXTEEN_BITS_INTEGER_MARKER | 0x0; // just to know the mask

		target.writeUint16BE(messageSize, 2); // content length is 2 bytes
		dataFrameBuffer = target;

		// alloc 4 bytes
		// [0] - 128 + 1 - 10000001 = 0x81 fin + opcode
		// [1] - 126 + 0 - payload marker length + mask indicator
		// [2] 0 - content length
		// [3] 113 - content length
		// [4, ...] - the message itself
	} else {
		throw new Error('message is too long :( ');
	}

	const totalLength = dataFrameBuffer.byteLength + messageSize;
	const dataFrameResponse = concat(
		[dataFrameBuffer, messageBuffer],
		totalLength
	);
	return dataFrameResponse;
}

function concat(bufferList, totalLength) {
	const target = Buffer.allocUnsafe(totalLength);
	let offset = 0;

	for (const buffer of bufferList) {
		console.log(buffer.toString());

		target.set(buffer, offset);
		offset += buffer.length;
	}

	return target;
}

function onSocketReadable(socket) {
	// consume the first byte (it doesn't contains usefull information)
	// 1 = 1 byte = 8 bits
	socket.read(1);

	// the second byte contains the payload length
	// we should remove the first bit from the second byte because it's a MASK INDICATOR
	// it's always '1' for client-to-server messages, so, we can subtract
	const [markerAndPayloadLength] = socket.read(1);
	const lengthIndicatorInBits = markerAndPayloadLength - FIRST_BIT;

	let messageLength = 0;
	if (lengthIndicatorInBits <= SEVEN_BITS_INTEGER_MARKER) {
		messageLength = lengthIndicatorInBits;
	} else if (lengthIndicatorInBits <= SIXTEEN_BITS_INTEGER_MARKER) {
		// unsigned, big-endian 16-bit integer [0 - 65K] - 2 ** 16
		messageLength = socket.read(2).readUint16BE(0);
	} else {
		throw new Error('the received message is too long');
	}

	const maskKey = socket.read(MASK_KEY_BYTES_LENGTH);
	const encoded = socket.read(messageLength);
	const decoded = unmask(encoded, maskKey);
	const received = decoded.toString('utf-8');

	const data = JSON.parse(received);
	console.log('message received!', data);

	// sending a response
	const message = JSON.stringify(data);

	sendMessage(message, socket);
}

function unmask(encodedBuffer, maskKey) {
	// because the maskKey has only 4 bytes
	// index % 4 === 0, 1, 2, 3 = index bits needed to decode the message

	// XOR ^
	// returns 1 if both are different
	// returns 0 if both are equal

	const finalBuffer = Buffer.from(encodedBuffer);

	for (let i = 0; i < encodedBuffer.length; i++) {
		finalBuffer[i] = encodedBuffer[i] ^ maskKey[i % MASK_KEY_BYTES_LENGTH];
	}

	return finalBuffer;
}

function prepareHandshakeHeaders(id) {
	const acceptKey = createSocketAccept(id);
	const headers = [
		'HTTP/1.1 101 Switching Protocols',
		'Upgrade: websocket',
		'Connection: Upgrade',
		`Sec-WebSocket-Accept: ${acceptKey}`,
		''
	]
		.map((line) => line.concat('\r\n'))
		.join('');

	return headers;
}

function createSocketAccept(id) {
	const sha1 = createHash('sha1');
	sha1.update(id + WEBSOCKET_MAGIC_STRING_KEY);

	return sha1.digest('base64');
}

// error handling to keep the server on
['uncaughtException', 'unhandledRejection'].forEach((event) =>
	process.on(event, (error) => {
		console.error(
			`something bad happened! event: ${event}, msg: ${
				error.stack || error
			} `
		);
	})
);
