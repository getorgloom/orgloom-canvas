// Post-install handler for the Org Loom managed package. Salesforce
// invokes onInstall() once per install or upgrade with an InstallContext
// describing who triggered it. We use that hook to assign the
// Orgloom_Admin permission set to the installing admin so the
// Org Loom server (which OAuths as that user) can immediately read +
// write Orgloom_Canvas__c records without a manual permset-assignment
// step the admin would otherwise have to remember.
//
// Why Admin and not User: the installing admin owns the canvases their
// server creates on behalf of any user in the org, and needs view-all /
// modify-all to manage them. The Org Loom User permset is for individual
// non-admin members; admins assign that separately.
//
// Re-install / upgrade behavior: if the assignment row already exists
// for this user, we skip silently. Re-asserting it would be harmless
// (same row) but the SOQL+skip pattern avoids a stray DML.
//
// Wired via sfdx-project.json's postInstallScript pointer at package
// version creation time. The class itself doesn't fire on source deploy
// meaning to test in a scratch org, invoke onInstall() manually via anonymous
// Apex (see scripts/apex/test-post-install.apex).

// Sharing: declared `without sharing` explicitly (rather than left
// implicit). As an InstallHandler this runs in a system context by design,
// and it touches only setup objects (PermissionSet, PermissionSetAssignment)
// to grant the packaged admin permset to the installer; no customer
// records, so there is no user-level sharing scope to honor. Declared
// explicitly so the security-review sharing scan (PMD ApexSharingViolations)
// is unambiguous.
public without sharing class OrgloomPostInstall implements InstallHandler {
	public void onInstall(InstallContext context) {
		Id installerId = context.installerId();
		if (installerId == null) {
			System.debug('OrgloomPostInstall: no installerId in context, skipping permset assignment');
			return;
		}
		assignAdminPermset(installerId);
	}

	// Visible for the test class. Idempotent: re-running on a user
	// who already has the assignment is a no-op. Returns true if a new
	// row was inserted, false if it was already present.
	@TestVisible
	private static Boolean assignAdminPermset(Id assigneeId) {
		// Filter by THIS package's namespace, not just the name; a
		// subscriber org can contain its own permset named 'Orgloom_Admin',
		// and an unfiltered LIMIT 1 could nondeterministically assign that
		// one instead of the packaged permset, leaving the installer
		// without the real grants. getName() is 'ns.ClassName' when
		// packaged, bare in scratch/unpackaged orgs (namespace null).
		String clsName = OrgloomPostInstall.class.getName();
		String ns = clsName.contains('.') ? clsName.substringBefore('.') : null;
		List<PermissionSet> sets = [
			SELECT Id FROM PermissionSet
			WHERE Name = 'Orgloom_Admin'
			  AND NamespacePrefix = :ns
			LIMIT 1
		];
		if (sets.isEmpty()) {
			System.debug('OrgloomPostInstall: Orgloom_Admin permset not found in this org; schema deploy may have failed');
			return false;
		}
		Id permsetId = sets[0].Id;
		List<PermissionSetAssignment> existing = [
			SELECT Id FROM PermissionSetAssignment
			WHERE AssigneeId = :assigneeId AND PermissionSetId = :permsetId LIMIT 1
		];
		if (!existing.isEmpty()) {
			System.debug('OrgloomPostInstall: assignee ' + assigneeId + ' already has Orgloom_Admin, skipping');
			return false;
		}
		insert new PermissionSetAssignment(
			AssigneeId = assigneeId,
			PermissionSetId = permsetId
		);
		System.debug('OrgloomPostInstall: assigned Orgloom_Admin to ' + assigneeId);
		return true;
	}
}
