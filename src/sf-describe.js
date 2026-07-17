// Salesforce describe helpers: pure-ish functions used by /api/objects
// and /api/objects/:name/describe. The route handlers in routes-v2.js
// own the gating + audit logging; this module owns the SF API mechanics
// + the dependent-picklist resolution.

import { withSfRetry } from './sf-upload.js';
import { isRequiredOnCreate, isPolymorphicReference } from './sf-field-structure.js';

export function cleanLabel(label, fallback) {
	if (typeof label !== 'string' || label.startsWith('__MISSING LABEL__')) {
		return fallback;
	}
	return label;
}

// Standard State/Country Picklists follow a naming convention: the
// state field is the country field with `State` in place of
// `Country`. Pattern-match when both the UI API and describe fail to
// report the controller.
export function inferScpController(fieldName, allFields) {
	if (!/State/.test(fieldName)) {
return null;
}
	const candidate = fieldName.replace(/State/, 'Country');
	if (candidate === fieldName) {
return null;
}
	return allFields.some((f) => f.name === candidate) ? candidate : null;
}

// Dependent-picklist validFor fields come from the REST describe API
// as a base64-encoded bitmap where bit N indicates the dependent value
// is valid for controller index N. Decode to the same array-of-indices
// format the UI API returns, so the client has a single representation.
// See https://salesforce.stackexchange.com/questions/4462
export function decodeValidForBitmap(validFor) {
	if (!validFor || typeof validFor !== 'string') {
return [];
}
	let bytes;
	try {
 bytes = Buffer.from(validFor, 'base64'); 
} catch (e) {
 return []; 
}
	const indices = [];
	for (let byteIdx = 0; byteIdx < bytes.length; byteIdx++) {
		const b = bytes[byteIdx];
		for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
			if (b & (0x80 >> bitIdx)) {
indices.push(byteIdx * 8 + bitIdx);
}
		}
	}
	return indices;
}

// Per-org cache of queryable sObject names from describeGlobal. The
// list is stable enough across a session that re-fetching it on every
// graph build wastes API calls; we key by orgId and TTL out after 30
// minutes so newly-added custom objects eventually show up.
const _queryableCache = new Map(); // orgId -> { set, expiresAt }
const QUERYABLE_TTL_MS = 30 * 60 * 1000;

function _buildQueryableSet(describeGlobalResult) {
	const set = new Set();
	for (const o of (describeGlobalResult && describeGlobalResult.sobjects) || []) {
		if (o && o.queryable && o.name) {
set.add(o.name);
}
	}
	return set;
}

function _primeQueryableCache(orgId, describeGlobalResult) {
	const set = _buildQueryableSet(describeGlobalResult);
	// Never cache under a falsy org id: two different connected orgs whose
	// sfOrgId resolves falsy would otherwise share one entry and cross-
	// contaminate the queryable set (the /graph route uses it to include/
	// exclude ring peers). Build the set for the caller, just don't store it.
	if (orgId) {
		_queryableCache.set(orgId, { set, expiresAt: Date.now() + QUERYABLE_TTL_MS });
	}
	return set;
}

export async function getQueryableSObjects(conn, orgId) {
	const now = Date.now();
	if (orgId) {
		const cached = _queryableCache.get(orgId);
		if (cached && cached.expiresAt > now) {
			return cached.set;
		}
	}
	try {
		const result = await withSfRetry(() => conn.describeGlobal());
		// Returns the freshly-built set; only caches when orgId is truthy.
		return _primeQueryableCache(orgId, result);
	} catch (err) {
		console.warn('[describeGlobal] failed for queryable cache:', err && err.message);
		return null;
	}
}

// Top-level "list every object in the org" projection. Keys the
// queryable-cache as a side effect so the first describe-graph call
// in a session doesn't re-pay describeGlobal.
export async function listObjects(conn, orgId) {
	const result = await withSfRetry(() => conn.describeGlobal());
	_primeQueryableCache(orgId, result);
	return result.sobjects
		.map((o) => ({
			name: o.name,
			label: cleanLabel(o.label, o.name),
			labelPlural: cleanLabel(o.labelPlural, o.name),
			keyPrefix: o.keyPrefix,
			queryable: o.queryable,
			custom: o.custom,
			// `createable` lets the client filter out platform/system
			// tables from the default picker.
			createable: !!o.createable,
		}))
		.sort((a, b) => a.label.localeCompare(b.label));
}

// Shared "is this a system/noise SObject?" predicate. Used to keep object
// pickers (schema-explorer graph, record browser) showing real business
// objects instead of the long tail of audit / event / chatter / FSL /
// async-process / Data.com / setup tables. Custom objects (__c) are always
// kept. Combine with a `createable` check to also catch the read-only
// system objects not enumerated here (e.g. *CleanInfo, *Template, most
// Setup objects): those aren't createable, so a createable filter removes
// them without needing an exhaustive name list.
// Suffix / prefix / exact-name patterns identifying system/setup objects.
// Single source of truth: the client object pickers no longer carry their
// own copy; everything reads the filtered list /api/objects returns.
const _NOISE_SOBJECT_SUFFIX =
	/(Feed|History|Share|ChangeEvent|Vote|Tag|RelationshipFor|OwnerSharingRule|EventStore|FlowInterview|Definition|Settings|Setting|Metrics|Localization|Bundle|CleanInfo)$/;
const _NOISE_SOBJECT_PREFIX =
	/^(AI|Activation|ActionLink|AppointmentScheduling|Apex|Async|Aura|Auth|Brand|Briefcase|CallCoaching|ChatterExtension|Cms|Collaboration|Content|CustomBrand|CustomHelp|Domain|DuplicateRecord|Einstein|EmailServices|External|Feed|Flow|Identity|Lightning|ListEmail|Login|MarketSegment|MktSgmnt|Mobile|Network|Oauth|Omni|Org|OutgoingEmail|Path|Permission|PlatformCache|Presence|Prompt|Recommendation|Scorecard|Setup|Site|Social|Static|UserProv|Wave)/;
const _NOISE_SOBJECT_NAMES = new Set([
	'AppMenuItem', 'AppTabMember', 'ListView', 'ListViewChart',
	'ListViewChartInstance', 'RecentlyViewed', 'UserRecordAccess',
	'UserPreference', 'UserSetupEntityAccess', 'UserAppMenuCustomization',
	'UserAppMenuItem', 'TabDefinition', 'AppDefinition', 'CustomApplication',
	'PermissionSetTabSetting', 'CombinedAttachment', 'AttachedContentDocument',
	'AttachedContentNote', 'TopicAssignment', 'BackgroundOperation',
	'AsyncApexJob', 'CronJobDetail', 'CronTrigger', 'NoteAndAttachment',
	'OpenActivity', 'ActivityHistory', 'AggregateResult', 'CaseStatus',
	'ContractStatus', 'EmailStatus', 'OrderStatus', 'TaskStatus',
	'OpportunityStage', 'ProcessInstanceHistory', 'ProcessInstanceStep',
	'ProcessInstanceWorkitem', 'ProcessInstanceNode', 'AdditionalNumber',
	'Profile', 'PermissionSet', 'PermissionSetGroup', 'PermissionSetAssignment',
	'FieldPermissions', 'ObjectPermissions', 'SetupAuditTrail', 'LoginHistory',
	'LoginIp', 'AuthSession', 'EventLogFile', 'Group', 'Queue', 'Role',
	'UserRole', 'Territory', 'Folder', 'RecordType', 'BusinessProcess',
	'BusinessHours', 'Holiday', 'Period', 'FiscalYearPeriod', 'BrandTemplate',
	'ConnectedApplication', 'Letterhead', 'Dashboard', 'Report', 'ReportFolder',
	'EmailTemplate', 'TenantUsageEntitlement', 'OutgoingEmailRelationship',
	'MailmergeTemplate', 'Macro', 'MacroInstruction', 'MacroUsage', 'UserListView',
	'UserListViewCriterion', 'EmbeddedServiceDetail', 'EmbeddedServiceLabel',
	'EmbeddedServiceFlowConfig', 'FieldHistoryArchive', 'EntityParticle',
	'Publisher', 'Scontrol', 'WebLink', 'MutingPermissionSet',
	'MyDomainDiscoverableLogin', 'PushTopic', 'QueueRoutingConfig',
	'QueueSobject', 'SearchPromotionRule', 'SecurityCustomBaseline',
	'LiveChatSensitiveDataRule', 'SPSamlAttributes', 'StreamingChannel',
	'TestSuiteMembership', 'TimeSlot', 'TransactionSecurityPolicy',
	'EntitlementTemplate', 'EmailDomainFilter', 'EmailDomainKey', 'EmailRelay',
	'EmailCapture', 'EmailRoutingAddress', 'IframeWhiteListUrl', 'CspTrustedSite',
	'RedirectWhitelistUrl', 'CorsWhitelistEntry', 'Translation', 'MilestoneType',
	'MlFeatureValueMetric', 'MLFilter', 'MLFilterValue', 'EngagementChannelType',
	'UserPackageLicense', 'UserAppInfo', 'AppAnalyticsQueryRequest',
	'AppUsageAssignment', 'CustomNotificationType', 'DocumentAttachmentMap',
	'DataUseLegalBasis', 'DataUsePurpose', 'CategoryNode', 'CategoryData',
	'CalendarView', 'CallCenter', 'ChatterExtension', 'ChatterExtensionConfig',
	'EmailServicesAddress', 'EmailServicesFunction', 'CollaborationInvitation',
	'ExpressionFilter', 'ExpressionFilterCriteria', 'CaseTeamTemplate',
	'CaseTeamTemplateMember', 'CaseTeamTemplateRecord',
	'ProductEntitlementTemplate', 'GtwyProvPaymentMethodType', 'Announcement',
	'EntitySubscription', 'ProcessException', 'OperatingHours',
	'OperatingHoursHoliday',
	// Standard config / system / agent-productivity / file-storage objects
	// that are createable+queryable (so they slip past the createable filter)
	// but aren't business records you'd model on the canvas. Identified by a
	// describeGlobal scan of standard objects. Family prefixes (Content, Feed,
	// Prompt, Scorecard, ListEmail, DuplicateRecord, Social, Recommendation)
	// are handled by _NOISE_SOBJECT_PREFIX; these are the remaining singletons.
	'Document', 'Image', 'EnhancedLetterhead', 'GroupMember', 'RecordAction',
	'Topic', 'QuickText', 'CampaignMemberStatus', 'EmailMessageRelation',
	'CaseSubjectParticle', 'CaseExternalDocument', 'CaseArticle', 'LinkedArticle',
	'CaseSolution', 'CaseTeamMember', 'CaseTeamRole', 'Knowledge__DataCategorySelection',
	'ConferenceNumber', 'IPAddressRange', 'TableauHostMapping', 'TodayGoal',
	'LocationTrustMeasure', 'PersonAccountOwnerPowerUser', 'PortalDelegablePermissionSet',
	'UserEmailPreferredPerson', 'UserDefinedLabel', 'UserDefinedLabelAssignment',
	'DataIntegrationRecordPurchasePermission',
]);
export function isNoiseSObject(name) {
	if (!name) {
		return true;
	}
	if (name.endsWith('__c')) {
		return false;
	}
	if (_NOISE_SOBJECT_NAMES.has(name)) {
		return true;
	}
	if (_NOISE_SOBJECT_SUFFIX.test(name)) {
		return true;
	}
	if (_NOISE_SOBJECT_PREFIX.test(name)) {
		return true;
	}
	return false;
}

// Heavy describe with dependent-picklist resolution. Returns
//   { name, label, fields, recordTypes, defaultRecordTypeId }
// matching the legacy /api/objects/:name/describe shape. Fields are
// projected with picklist values per record type, controller info
// resolved from describe + UI API + SCP-naming-pattern fallback,
// and validFor bitmaps decoded so the client has a single
// representation across record types.
export async function loadDescribeForObject(conn, objectName) {
	const describe = await conn.sobject(objectName).describe();

	let recordTypes = [];
	let defaultRecordTypeId = null;
	const picklistByRt = {}; // rtId -> fieldName -> { values, defaultValue }
	const uiApiControllerByField = {};

	try {
		const apiVersion = conn.version || '60.0';
		const base = '/services/data/v' + apiVersion;
		const objectInfo = await conn.request(base + '/ui-api/object-info/' + encodeURIComponent(objectName));
		defaultRecordTypeId = (objectInfo && objectInfo.defaultRecordTypeId) || null;
		// UI API exposes `fields[name].controllingFields = [...]`. That's
		// the reliable source for "who controls this field" on
		// State/Country Picklists where describe leaves controllerName
		// null.
		if (objectInfo && objectInfo.fields) {
			Object.entries(objectInfo.fields).forEach(([fname, finfo]) => {
				if (Array.isArray(finfo && finfo.controllingFields) && finfo.controllingFields.length > 0) {
					uiApiControllerByField[fname] = finfo.controllingFields[0];
				}
			});
		}
		// The UI API object-info doesn't reliably expose the RecordType
		// DeveloperName, but the raw describe does (recordTypeInfos[] since
		// API v43). Map recordTypeId -> developerName so cross-org migration
		// can resolve record types by their portable DeveloperName (Ids are
		// not portable across orgs).
		const rawRtDevName = {};
		for (const info of describe.recordTypeInfos || []) {
			if (info && info.recordTypeId && info.developerName) {
				rawRtDevName[info.recordTypeId] = info.developerName;
			}
		}
		const rtInfos = (objectInfo && objectInfo.recordTypeInfos) || {};
		recordTypes = Object.entries(rtInfos)
			.filter(([, info]) => info && info.available)
			.map(([id, info]) => ({
				id,
				name: info.name,
				label: info.name,
				developerName: rawRtDevName[id] || null,
				isDefault: id === defaultRecordTypeId,
			}));
		if (recordTypes.length === 0 && defaultRecordTypeId) {
			recordTypes = [{
				id: defaultRecordTypeId,
				name: 'Master',
				label: 'Master',
				developerName: rawRtDevName[defaultRecordTypeId] || 'Master',
				isDefault: true,
			}];
		}
		await Promise.all(recordTypes.map(async (rt) => {
			try {
				const data = await conn.request(base + '/ui-api/object-info/' + encodeURIComponent(objectName) + '/picklist-values/' + rt.id);
				if (data && data.picklistFieldValues) {
					picklistByRt[rt.id] = data.picklistFieldValues;
				}
			} catch (e) {
				console.warn('Picklist values fetch failed for', objectName, 'RT', rt.id, ':', e.message || e);
			}
		}));

		// Second pass: dependent picklist fields. Object-level endpoint
		// sometimes returns values WITHOUT controllerValues (User.
		// StateCode case). Re-fetch per-field whenever data is
		// incomplete for dependency filtering.
		const dependentFieldNames = describe.fields
			.filter((f) => {
				if (!f.createable) {
return false;
}
				// Only real picklist fields have per-field picklist values. The
				// name-based SCP inference below matches text aliases like
				// BillingState/ShippingState when State & Country Picklists are
				// OFF in the org: those are `string` fields, and fetching their
				// picklist-values 404s ("Field X is not a picklist"). Gate on
				// type so we only per-field-fetch genuine picklists (incl. the
				// *Code picklist fields when SCP is on).
				if (f.type !== 'picklist' && f.type !== 'multipicklist') {
return false;
}
				return !!(f.dependentPicklist
					|| f.controllerName
					|| uiApiControllerByField[f.name]
					|| inferScpController(f.name, describe.fields));
			})
			.map((f) => f.name);
		await Promise.all(recordTypes.flatMap((rt) => dependentFieldNames.map(async (fname) => {
			const existing = picklistByRt[rt.id] && picklistByRt[rt.id][fname];
			if (existing
				&& Array.isArray(existing.values) && existing.values.length > 0
				&& existing.controllerValues && Object.keys(existing.controllerValues).length > 0) {
return;
}
			try {
				const data = await conn.request(base + '/ui-api/object-info/' + encodeURIComponent(objectName) + '/picklist-values/' + rt.id + '/' + encodeURIComponent(fname));
				if (data) {
					if (!picklistByRt[rt.id]) {
picklistByRt[rt.id] = {};
}
					const mergedValues = (Array.isArray(data.values) && data.values.length > 0)
						? data.values
						: ((existing && Array.isArray(existing.values)) ? existing.values : []);
					const mergedCtrl = (data.controllerValues && Object.keys(data.controllerValues).length > 0)
						? data.controllerValues
						: ((existing && existing.controllerValues) || null);
					picklistByRt[rt.id][fname] = {
						values: mergedValues,
						controllerValues: mergedCtrl,
						defaultValue: data.defaultValue || (existing && existing.defaultValue) || null,
					};
				}
			} catch (e) {
				console.warn('Per-field picklist-values fetch failed for', objectName, fname, 'RT', rt.id, ':', e.message || e);
			}
		})));
	} catch (e) {
		const msg = (e && e.message) || String(e);
		// A large set of objects (*CleanInfo, *Template, *Feed, *Share,
		// *History, and most system/setup objects) simply aren't exposed
		// in the Salesforce UI API. That's expected, not an error: the
		// describe still works from the raw metadata; we just skip the
		// UI-API-only enrichment (default record type + dependent-picklist
		// resolution). Stay silent on that known case so logs aren't spammed
		// with one line per unsupported object; warn only on real failures.
		if (!/not supported in UI API|UNSUPPORTED_API|not supported/i.test(msg)) {
			console.warn('UI API object-info fetch failed for', objectName, '-', msg);
		}
	}

	// Pre-compute "controller value → index" map per controlled field
	// using the controller field's FULL picklistValues list (including
	// inactive). Salesforce's validFor bitmap is indexed against every
	// describe entry: filtering out inactive shifts indices and
	// produces wrong / empty results.
	const controllerIndexMap = {};
	describe.fields.forEach((f) => {
		const ctrlName = f.controllerName
			|| uiApiControllerByField[f.name]
			|| inferScpController(f.name, describe.fields);
		if (!ctrlName) {
return;
}
		const ctrl = describe.fields.find((ff) => ff.name === ctrlName);
		if (!ctrl || !Array.isArray(ctrl.picklistValues)) {
return;
}
		const map = {};
		ctrl.picklistValues.forEach((pv, i) => {
 map[pv.value] = i; 
});
		controllerIndexMap[f.name] = map;
	});

	// Preserve every field Salesforce exposes to this user, including
	// readable-but-unwritable fields. Consumers that edit/create filter on
	// createable/updateable; CSV import additionally needs the negative FLS
	// metadata so it can name dropped columns and require explicit consent.
	const fields = describe.fields
		.map((f) => {
			const resolvedControllerName = f.controllerName
				|| uiApiControllerByField[f.name]
				|| inferScpController(f.name, describe.fields)
				|| null;
			const describeValues = (f.picklistValues || [])
				.filter((pv) => pv.active)
				.map((pv) => ({
					label: pv.label,
					value: pv.value,
					defaultValue: pv.defaultValue,
					validFor: resolvedControllerName ? decodeValidForBitmap(pv.validFor) : [],
				}));
			const describeCtrlMap = controllerIndexMap[f.name] || null;
			const picklistValuesByRecordType = {};
			const controllerValuesByRecordType = {};
			recordTypes.forEach((rt) => {
				const entry = picklistByRt[rt.id] && picklistByRt[rt.id][f.name];
				if (entry && Array.isArray(entry.values) && entry.values.length > 0) {
					const defVal = entry.defaultValue && entry.defaultValue.value;
					picklistValuesByRecordType[rt.id] = entry.values.map((v) => ({
						label: v.label,
						value: v.value,
						defaultValue: v.value === defVal,
						validFor: Array.isArray(v.validFor) ? v.validFor : [],
					}));
				} else if (describeValues.length > 0) {
					picklistValuesByRecordType[rt.id] = describeValues;
				}
				const entryCtrlValues = entry && entry.controllerValues;
				if (entryCtrlValues && Object.keys(entryCtrlValues).length > 0) {
					controllerValuesByRecordType[rt.id] = entryCtrlValues;
				} else if (describeCtrlMap) {
					controllerValuesByRecordType[rt.id] = describeCtrlMap;
				}
			});
			const fallback = (defaultRecordTypeId && picklistValuesByRecordType[defaultRecordTypeId])
				|| describeValues;
			return {
				name: f.name,
				label: cleanLabel(f.label, f.name),
				type: f.type,
				custom: !!f.custom,
				createable: !!f.createable,
				updateable: !!f.updateable,
				required: isRequiredOnCreate(f),
				nillable: !!f.nillable,
				defaultedOnCreate: !!f.defaultedOnCreate,
				calculated: !!f.calculated,
				autoNumber: !!f.autoNumber,
				restrictedPicklist: !!f.restrictedPicklist,
				length: f.length,
				precision: f.precision,
				scale: f.scale,
				digits: f.digits,
				picklistValues: fallback,
				picklistValuesByRecordType,
				controllerName: resolvedControllerName,
				// Top-level controller map: unconditional fallback for
				// orgs / objects where the UI API returns no record types
				// (User has none). Without this, dependent filtering only
				// works when there's a record-type key to hang the per-
				// RT map on.
				controllerValues: describeCtrlMap,
				controllerValuesByRecordType,
				referenceTo: f.referenceTo,
				referenceTargetField: f.referenceTargetField || null,
				polymorphicForeignKey: isPolymorphicReference(f),
				reparentableMasterDetail: f.reparentableMasterDetail == null ? null : !!f.reparentableMasterDetail,
				relationshipName: f.relationshipName,
				defaultValue: f.defaultValue,
				helpText: f.inlineHelpText,
				// Identity flags: used by cross-org migrate matching to
				// surface good key-field candidates (external ids first,
				// then unique fields, then the name field) and by the
				// client to gauge whether a field is a safe match key.
				externalId: !!f.externalId,
				idLookup: !!f.idLookup,
				unique: !!f.unique,
				nameField: !!f.nameField,
				// Match Existing and record filters may only place fields in a
				// SOQL WHERE clause when Salesforce marks them filterable. Long
				// text fields such as Contact.Description are a common example of
				// readable fields that are not valid filter keys.
				filterable: !!f.filterable,
			};
		});
	return {
		name: describe.name,
		label: cleanLabel(describe.label, describe.name),
		// Object-level CRUD flags from the SF describe. Surfaced so the
		// client can pre-check "can this user even create/update records of
		// this object" at object-pick time, before the user maps columns
		// and clicks Upload, instead of only finding out via a per-record
		// INSUFFICIENT_ACCESS_OR_READONLY at DML time.
		createable: !!describe.createable,
		updateable: !!describe.updateable,
		queryable: !!describe.queryable,
		fields,
		recordTypes,
		defaultRecordTypeId,
	};
}
