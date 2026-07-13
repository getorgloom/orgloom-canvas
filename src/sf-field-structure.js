export function isCompoundContainer(field) {
	return !!field && (field.type === 'address' || field.type === 'location');
}

export function isRequiredOnCreate(field) {
	return isCreateInputField(field)
		&& field.nillable === false
		&& !field.defaultedOnCreate
		;
}

export function isCreateInputField(field) {
	return !!field
		&& !!field.createable
		&& !field.calculated
		&& !field.autoNumber
		&& !isCompoundContainer(field);
}

export function isWritableForOperation(field, operation) {
	if (!field || !field.name || isCompoundContainer(field)) {
return false;
}
	if (field.calculated || field.autoNumber) {
return false;
}
	if (operation === 'update') {
return !!field.updateable;
}
	if (operation === 'upsert') {
return isCreateInputField(field) || !!field.updateable;
}
	return isCreateInputField(field);
}

export function isPolymorphicReference(field) {
	return !!field
		&& field.type === 'reference'
		&& Array.isArray(field.referenceTo)
		&& field.referenceTo.length > 1;
}
