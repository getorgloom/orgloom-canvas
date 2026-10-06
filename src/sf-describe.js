// Salesforce schema projection shared by object pickers, editors, imports, and upload validation.
import { withSfRetry } from './sf-upload.js';
import { isSpecializedSObject } from './sf-object-support.js';

export { isSpecializedSObject } from './sf-object-support.js';
import { isRequiredOnCreate, isPolymorphicReference } from './sf-field-structure.js';

export function cleanLabel(label, fallback) {
	if (typeof label !== 'string' || label.startsWith('__MISSING LABEL__')) {
		return fallback;
	}
	return label;
}

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

const _queryableCache = new Map(); // orgId|userId -> { set, expiresAt }
const QUERYABLE_TTL_MS = 30 * 60 * 1000;

function _queryableCacheKey(orgId, userId) {
	if (!orgId || !userId) {
		return null;
	}
	return String(orgId).slice(0, 15) + '|' + String(userId).slice(0, 15);
}

function _buildQueryableSet(describeGlobalResult) {
	const set = new Set();
	for (const o of (describeGlobalResult && describeGlobalResult.sobjects) || []) {
		if (o && o.queryable && o.name) {
			set.add(o.name);
		}
	}
	return set;
}

function _primeQueryableCache(orgId, userId, describeGlobalResult) {
	const set = _buildQueryableSet(describeGlobalResult);
	const cacheKey = _queryableCacheKey(orgId, userId);
	if (cacheKey) {
		_queryableCache.set(cacheKey, { set, expiresAt: Date.now() + QUERYABLE_TTL_MS });
	}
	return set;
}

export async function getQueryableSObjects(conn, orgId, userId) {
	// Queryability reflects the Salesforce user's permissions, not only the org schema.
	const now = Date.now();
	const cacheKey = _queryableCacheKey(orgId, userId);
	if (cacheKey) {
		const cached = _queryableCache.get(cacheKey);
		if (cached && cached.expiresAt > now) {
			return cached.set;
		}
	}
	try {
		const result = await withSfRetry(() => conn.describeGlobal());
		return _primeQueryableCache(orgId, userId, result);
	} catch (err) {
		console.warn('[describeGlobal] failed for queryable cache:', err && err.message);
		return null;
	}
}

export async function listObjects(conn, orgId, userId) {
	const result = await withSfRetry(() => conn.describeGlobal());
	_primeQueryableCache(orgId, userId, result);
	return result.sobjects
		.map((o) => ({
			name: o.name,
			label: cleanLabel(o.label, o.name),
			labelPlural: cleanLabel(o.labelPlural, o.name),
			keyPrefix: o.keyPrefix,
			queryable: o.queryable,
			custom: o.custom,
			createable: !!o.createable,
			deletable: !!o.deletable,
		}))
		.sort((a, b) => a.label.localeCompare(b.label));
}

const _NOISE_SOBJECT_SUFFIX =
	/(Feed|History|Share|ChangeEvent|Vote|Tag|RelationshipFor|OwnerSharingRule|EventStore|FlowInterview|Definition|Settings|Setting|Metrics|Localization|Bundle|CleanInfo)$/;
const _NOISE_SOBJECT_PREFIX =
	/^(AI|Activation|ActionLink|AppointmentScheduling|Apex|Async|Aura|Auth|Brand|Briefcase|CallCoaching|ChatterExtension|Cms|Collaboration|Content|CustomBrand|CustomHelp|Domain|DuplicateRecord|Einstein|EmailServices|External|Feed|Flow|Identity|Lightning|ListEmail|Login|MarketSegment|MktSgmnt|Mobile|Network|Oauth|Omni|Org|OutgoingEmail|Path|Permission|PlatformCache|Presence|Prompt|Recommendation|Scorecard|Setup|Site|Social|Static|UserProv|Wave)/;
const _NOISE_SOBJECT_NAMES = new Set([
	'AppMenuItem',
	'AppTabMember',
	'ListView',
	'ListViewChart',
	'ListViewChartInstance',
	'RecentlyViewed',
	'UserRecordAccess',
	'UserPreference',
	'UserSetupEntityAccess',
	'UserAppMenuCustomization',
	'UserAppMenuItem',
	'TabDefinition',
	'AppDefinition',
	'CustomApplication',
	'PermissionSetTabSetting',
	'CombinedAttachment',
	'AttachedContentDocument',
	'AttachedContentNote',
	'TopicAssignment',
	'BackgroundOperation',
	'AsyncApexJob',
	'CronJobDetail',
	'CronTrigger',
	'NoteAndAttachment',
	'OpenActivity',
	'ActivityHistory',
	'AggregateResult',
	'CaseStatus',
	'ContractStatus',
	'EmailStatus',
	'OrderStatus',
	'TaskStatus',
	'OpportunityStage',
	'ProcessInstanceHistory',
	'ProcessInstanceStep',
	'ProcessInstanceWorkitem',
	'ProcessInstanceNode',
	'AdditionalNumber',
	'Profile',
	'PermissionSet',
	'PermissionSetGroup',
	'PermissionSetAssignment',
	'FieldPermissions',
	'ObjectPermissions',
	'SetupAuditTrail',
	'LoginHistory',
	'LoginIp',
	'AuthSession',
	'EventLogFile',
	'Group',
	'Queue',
	'Role',
	'UserRole',
	'Territory',
	'Folder',
	'RecordType',
	'BusinessProcess',
	'BusinessHours',
	'Holiday',
	'Period',
	'FiscalYearPeriod',
	'BrandTemplate',
	'ConnectedApplication',
	'Letterhead',
	'Dashboard',
	'Report',
	'ReportFolder',
	'EmailTemplate',
	'TenantUsageEntitlement',
	'OutgoingEmailRelationship',
	'MailmergeTemplate',
	'Macro',
	'MacroInstruction',
	'MacroUsage',
	'UserListView',
	'UserListViewCriterion',
	'EmbeddedServiceDetail',
	'EmbeddedServiceLabel',
	'EmbeddedServiceFlowConfig',
	'FieldHistoryArchive',
	'EntityParticle',
	'Publisher',
	'Scontrol',
	'WebLink',
	'MutingPermissionSet',
	'MyDomainDiscoverableLogin',
	'PushTopic',
	'QueueRoutingConfig',
	'QueueSobject',
	'SearchPromotionRule',
	'SecurityCustomBaseline',
	'LiveChatSensitiveDataRule',
	'SPSamlAttributes',
	'StreamingChannel',
	'TestSuiteMembership',
	'TimeSlot',
	'TransactionSecurityPolicy',
	'EntitlementTemplate',
	'EmailDomainFilter',
	'EmailDomainKey',
	'EmailRelay',
	'EmailCapture',
	'EmailRoutingAddress',
	'IframeWhiteListUrl',
	'CspTrustedSite',
	'RedirectWhitelistUrl',
	'CorsWhitelistEntry',
	'Translation',
	'MilestoneType',
	'MlFeatureValueMetric',
	'MLFilter',
	'MLFilterValue',
	'EngagementChannelType',
	'UserPackageLicense',
	'UserAppInfo',
	'AppAnalyticsQueryRequest',
	'AppUsageAssignment',
	'CustomNotificationType',
	'DocumentAttachmentMap',
	'DataUseLegalBasis',
	'DataUsePurpose',
	'CategoryNode',
	'CategoryData',
	'CalendarView',
	'CallCenter',
	'ChatterExtension',
	'ChatterExtensionConfig',
	'EmailServicesAddress',
	'EmailServicesFunction',
	'CollaborationInvitation',
	'ExpressionFilter',
	'ExpressionFilterCriteria',
	'CaseTeamTemplate',
	'CaseTeamTemplateMember',
	'CaseTeamTemplateRecord',
	'ProductEntitlementTemplate',
	'GtwyProvPaymentMethodType',
	'Announcement',
	'EntitySubscription',
	'ProcessException',
	'OperatingHours',
	'OperatingHoursHoliday',
	'Document',
	'Image',
	'EnhancedLetterhead',
	'GroupMember',
	'RecordAction',
	'Topic',
	'QuickText',
	'CampaignMemberStatus',
	'EmailMessageRelation',
	'CaseSubjectParticle',
	'CaseExternalDocument',
	'CaseArticle',
	'LinkedArticle',
	'CaseSolution',
	'CaseTeamMember',
	'CaseTeamRole',
	'Knowledge__DataCategorySelection',
	'ConferenceNumber',
	'IPAddressRange',
	'TableauHostMapping',
	'TodayGoal',
	'LocationTrustMeasure',
	'PersonAccountOwnerPowerUser',
	'PortalDelegablePermissionSet',
	'UserEmailPreferredPerson',
	'UserDefinedLabel',
	'UserDefinedLabelAssignment',
	'DataIntegrationRecordPurchasePermission',
]);
export function isNoiseSObject(name) {
	if (!name) {
		return true;
	}
	if (isSpecializedSObject(name)) {
		return true;
	}
	// Ordinary custom objects stay visible even when their names resemble generated tables.
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

export async function loadDescribeForObject(conn, objectName) {
	// Keep readable-but-unwritable fields so clients can explain FLS omissions accurately.
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
		if (objectInfo && objectInfo.fields) {
			Object.entries(objectInfo.fields).forEach(([fname, finfo]) => {
				if (Array.isArray(finfo && finfo.controllingFields) && finfo.controllingFields.length > 0) {
					uiApiControllerByField[fname] = finfo.controllingFields[0];
				}
			});
		}
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
			recordTypes = [
				{
					id: defaultRecordTypeId,
					name: 'Master',
					label: 'Master',
					developerName: rawRtDevName[defaultRecordTypeId] || 'Master',
					isDefault: true,
				},
			];
		}
		await Promise.all(
			recordTypes.map(async (rt) => {
				try {
					const data = await conn.request(
						base + '/ui-api/object-info/' + encodeURIComponent(objectName) + '/picklist-values/' + rt.id,
					);
					if (data && data.picklistFieldValues) {
						picklistByRt[rt.id] = data.picklistFieldValues;
					}
				} catch (e) {
					console.warn('Picklist values fetch failed for', objectName, 'RT', rt.id, ':', e.message || e);
				}
			}),
		);

		const dependentFieldNames = describe.fields
			.filter((f) => {
				if (!f.createable) {
					return false;
				}
				if (f.type !== 'picklist' && f.type !== 'multipicklist') {
					return false;
				}
				return !!(
					f.dependentPicklist ||
					f.controllerName ||
					uiApiControllerByField[f.name] ||
					inferScpController(f.name, describe.fields)
				);
			})
			.map((f) => f.name);
		await Promise.all(
			recordTypes.flatMap((rt) =>
				dependentFieldNames.map(async (fname) => {
					const existing = picklistByRt[rt.id] && picklistByRt[rt.id][fname];
					if (
						existing &&
						Array.isArray(existing.values) &&
						existing.values.length > 0 &&
						existing.controllerValues &&
						Object.keys(existing.controllerValues).length > 0
					) {
						return;
					}
					try {
						const data = await conn.request(
							base +
								'/ui-api/object-info/' +
								encodeURIComponent(objectName) +
								'/picklist-values/' +
								rt.id +
								'/' +
								encodeURIComponent(fname),
						);
						if (data) {
							if (!picklistByRt[rt.id]) {
								picklistByRt[rt.id] = {};
							}
							const mergedValues =
								Array.isArray(data.values) && data.values.length > 0
									? data.values
									: existing && Array.isArray(existing.values)
										? existing.values
										: [];
							const mergedCtrl =
								data.controllerValues && Object.keys(data.controllerValues).length > 0
									? data.controllerValues
									: (existing && existing.controllerValues) || null;
							picklistByRt[rt.id][fname] = {
								values: mergedValues,
								controllerValues: mergedCtrl,
								defaultValue: data.defaultValue || (existing && existing.defaultValue) || null,
							};
						}
					} catch (e) {
						console.warn(
							'Per-field picklist-values fetch failed for',
							objectName,
							fname,
							'RT',
							rt.id,
							':',
							e.message || e,
						);
					}
				}),
			),
		);
	} catch (e) {
		const msg = (e && e.message) || String(e);
		if (!/not supported in UI API|UNSUPPORTED_API|not supported/i.test(msg)) {
			console.warn('UI API object-info fetch failed for', objectName, '-', msg);
		}
	}

	const controllerIndexMap = {};
	describe.fields.forEach((f) => {
		const ctrlName =
			f.controllerName || uiApiControllerByField[f.name] || inferScpController(f.name, describe.fields);
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

	const fields = describe.fields.map((f) => {
		const resolvedControllerName =
			f.controllerName || uiApiControllerByField[f.name] || inferScpController(f.name, describe.fields) || null;
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
			if (entry && Array.isArray(entry.values)) {
				const defVal = entry.defaultValue && entry.defaultValue.value;
				picklistValuesByRecordType[rt.id] = entry.values.map((v) => ({
					label: v.label,
					value: v.value,
					defaultValue: v.value === defVal,
					validFor: Array.isArray(v.validFor) ? v.validFor : [],
				}));
			}
			const entryCtrlValues = entry && entry.controllerValues;
			if (entryCtrlValues && Object.keys(entryCtrlValues).length > 0) {
				controllerValuesByRecordType[rt.id] = entryCtrlValues;
			} else if (describeCtrlMap) {
				controllerValuesByRecordType[rt.id] = describeCtrlMap;
			}
		});
		const fallback = (defaultRecordTypeId && picklistValuesByRecordType[defaultRecordTypeId]) || describeValues;
		return {
			name: f.name,
			label: cleanLabel(f.label, f.name),
			type: f.type,
			htmlFormatted: !!f.htmlFormatted,
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
			controllerValues: describeCtrlMap,
			controllerValuesByRecordType,
			referenceTo: f.referenceTo,
			referenceTargetField: f.referenceTargetField || null,
			polymorphicForeignKey: isPolymorphicReference(f),
			reparentableMasterDetail: f.reparentableMasterDetail == null ? null : !!f.reparentableMasterDetail,
			relationshipName: f.relationshipName,
			defaultValue: f.defaultValue,
			helpText: f.inlineHelpText,
			externalId: !!f.externalId,
			idLookup: !!f.idLookup,
			unique: !!f.unique,
			nameField: !!f.nameField,
			filterable: !!f.filterable,
			compoundFieldName: f.compoundFieldName || null,
		};
	});
	return {
		name: describe.name,
		label: cleanLabel(describe.label, describe.name),
		createable: !!describe.createable,
		updateable: !!describe.updateable,
		deletable: !!describe.deletable,
		queryable: !!describe.queryable,
		fields,
		recordTypes,
		defaultRecordTypeId,
	};
}
