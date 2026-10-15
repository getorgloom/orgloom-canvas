// Preserve nested query structure instead of matching FROM clauses with a flat regex.
export class SoqlImportError extends Error {
	constructor(error, message) {
		super(message || error);
		this.body = { error, ...(message ? { message } : {}) };
	}
}

export function parseSoqlImportQuery(soql) {
	const root = { soql, children: [] };
	const queries = [root];
	const parentheses = [];
	let quoted = false;
	for (let i = 0; i < soql.length; i++) {
		const char = soql[i];
		if (quoted) {
			if (char === '\\') {
				i++;
			} else if (char === "'") {
				quoted = false;
			}
			continue;
		}
		if (char === "'") {
			quoted = true;
		} else if (char === '(') {
			let query = null;
			if (/^\s*SELECT\b/i.test(soql.slice(i + 1))) {
				if (queries.length >= 5) {
					throw new SoqlImportError(
						'query-too-deep',
						'SOQL import supports up to five object levels, including the root object.',
					);
				}
				query = { children: [] };
				queries.at(-1).children.push(query);
				queries.push(query);
			}
			parentheses.push({ start: i + 1, query });
		} else if (char === ')') {
			const frame = parentheses.pop();
			if (!frame) {
				throw new SoqlImportError('invalid-query', 'Query parentheses are not balanced.');
			}
			if (frame.query) {
				frame.query.soql = soql.slice(frame.start, i).trim();
				queries.pop();
			}
		}
	}
	if (quoted || parentheses.length) {
		throw new SoqlImportError('invalid-query', 'Query has an unclosed string or parenthesis.');
	}
	return root;
}

// Each plan node has already been resolved against its immediate parent's describe.
// Only scalar fields are copied; nested results become records and relationship edges.
export function flattenSoqlImportResults(rows, plan, cap) {
	const records = [];
	const associations = [];
	function visit(row, node, parentTempId) {
		if (!row || !row.Id) {
			throw new SoqlImportError(parentTempId ? 'subquery-must-include-id' : 'must-include-id');
		}
		if (records.length >= cap) {
			throw new SoqlImportError(
				'result-exceeds-cap',
				'Result exceeds the ' +
					cap +
					'-record canvas cap across all query levels. Add a LIMIT or narrow your subqueries.',
			);
		}
		const tempId = 't' + (records.length + 1);
		const values = {};
		for (const [key, value] of Object.entries(row)) {
			if (key !== 'attributes' && node.fieldNames.has(key) && value !== null) {
				values[key] = value;
			}
		}
		records.push({ tempId, objectName: node.objectName, loadedFromId: row.Id, values });
		if (parentTempId && node.relationship.field) {
			associations.push({ fromTempId: tempId, toTempId: parentTempId, fieldName: node.relationship.field });
		}
		for (const [key, value] of Object.entries(row)) {
			if (key === 'attributes' || node.fieldNames.has(key) || value == null) {
				continue;
			}
			const child = node.children.find(
				(candidate) => candidate.relationship.relationshipName.toLowerCase() === key.toLowerCase(),
			);
			if (!child) {
				if (Array.isArray(value.records)) {
					throw new SoqlImportError(
						'unknown-subquery-relationship',
						'Unexpected child relationship ' + key + ' on ' + node.objectName + '.',
					);
				}
				continue;
			}
			if (!Array.isArray(value.records)) {
				throw new SoqlImportError('aggregate-subquery-not-supported');
			}
			if (value.done === false || value.nextRecordsUrl || value.totalSize > value.records.length) {
				throw new SoqlImportError(
					'incomplete-subquery-results',
					'Salesforce returned only part of ' +
						key +
						'. Narrow the query or add a child LIMIT before importing. No records were added.',
				);
			}
			for (const childRow of value.records) {
				visit(childRow, child, tempId);
			}
		}
	}
	for (const row of rows) {
		visit(row, plan, null);
	}
	return { records, associations };
}
