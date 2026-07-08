


















export function escapeSoqlLiteral(value) {
	if (value == null) {
return '';
}
	return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
