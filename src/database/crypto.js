
import crypto from "node:crypto";

const _key = process.env.ENCRYPTION_KEY
	? Buffer.from(process.env.ENCRYPTION_KEY, "hex")
	: null;

if (_key && _key.length !== 32) {
	console.error(
		"[crypto] ENCRYPTION_KEY must be 32 bytes (64 hex chars). Got",
		_key.length,
		"bytes. Refresh-token encryption disabled.",
	);
}

const _ready = !!_key && _key.length === 32;

export function isEncryptionAvailable() {
	return _ready;
}

export function encrypt(plaintext) {
	if (!_ready) {
		throw new Error(
			"Encryption not configured: set ENCRYPTION_KEY (64 hex chars) on the server.",
		);
	}
	if (typeof plaintext !== "string" || plaintext.length === 0) {
		throw new Error("encrypt: plaintext must be a non-empty string");
	}
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", _key, iv);
	const enc = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return (
		iv.toString("hex") +
		":" +
		enc.toString("hex") +
		":" +
		tag.toString("hex")
	);
}

export function decrypt(encoded) {
	if (!_ready) {
		throw new Error(
			"Encryption not configured: set ENCRYPTION_KEY (64 hex chars) on the server.",
		);
	}
	if (typeof encoded !== "string") {
		throw new Error("decrypt: input must be a string");
	}
	const parts = encoded.split(":");
	if (parts.length !== 3) {
		throw new Error("decrypt: malformed ciphertext");
	}
	const [ivHex, ctHex, tagHex] = parts;
	const iv = Buffer.from(ivHex, "hex");
	if (iv.length !== 12) {
		throw new Error("decrypt: malformed IV");
	}
	const tag = Buffer.from(tagHex, "hex");



	if (tag.length !== 16) {
		throw new Error("decrypt: invalid auth tag length");
	}
	const decipher = crypto.createDecipheriv(
		"aes-256-gcm",
		_key,
		iv,
		{ authTagLength: 16 },
	);
	decipher.setAuthTag(tag);
	const dec = Buffer.concat([
		decipher.update(Buffer.from(ctHex, "hex")),
		decipher.final(),
	]);
	return dec.toString("utf8");
}
