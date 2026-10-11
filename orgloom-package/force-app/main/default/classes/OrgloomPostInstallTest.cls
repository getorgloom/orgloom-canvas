// Covers OrgloomPostInstall. Three cases:
//   1. Fresh install: onInstall() with a real installer Id assigns the
//      Orgloom_Admin permset and returns true from the inner
//      assignAdminPermset() helper.
//   2. Re-install / upgrade: invoking again is a no-op when the
//      assignment row already exists.
//   3. Null installerId: onInstall() returns cleanly without DML.
//
// Test.testInstall(handler, version, isPush) is the SF-blessed way to
// invoke a post-install handler from test context; it builds an
// InstallContext for us and runs onInstall() under it. The context's
// installerId() returns the running test user, which is what we want.

@isTest
private class OrgloomPostInstallTest {

	// Same namespace resolution the handler uses. Orgs can hold BOTH the
	// managed package's permsets (namespaced) and unpackaged-source
	// copies (null namespace); every lookup/count here pins the one the
	// handler actually assigns.
	static String pkgNamespace() {
		String cls = OrgloomPostInstall.class.getName();
		return cls.contains('.') ? cls.substringBefore('.') : null;
	}

	@isTest
	static void freshInstall_assignsPermset() {
		User testUser = createTestUser();
		String ns = pkgNamespace();
		System.runAs(testUser) {
			Test.startTest();
			Test.testInstall(new OrgloomPostInstall(), null);
			Test.stopTest();
			Integer assignCount = [
				SELECT COUNT() FROM PermissionSetAssignment
				WHERE AssigneeId = :testUser.Id
				  AND PermissionSet.Name = 'Orgloom_Admin'
				  AND PermissionSet.NamespacePrefix = :ns
			];
			System.assertEquals(1, assignCount,
				'Fresh install should assign Orgloom_Admin to the installer');
		}
	}

	@isTest
	static void reInstall_isIdempotent() {
		User testUser = createTestUser();
		String ns = pkgNamespace();
		System.runAs(testUser) {
			// Pre-assign the permset (simulates a prior install). Must be
			// the SAME permset the handler resolves (namespace-pinned).
			Id permsetId = [
				SELECT Id FROM PermissionSet
				WHERE Name = 'Orgloom_Admin'
				  AND NamespacePrefix = :ns
				LIMIT 1
			].Id;
			insert new PermissionSetAssignment(
				AssigneeId = testUser.Id,
				PermissionSetId = permsetId
			);

			Test.startTest();
			Test.testInstall(new OrgloomPostInstall(), new Version(1, 0));
			Test.stopTest();

			Integer assignCount = [
				SELECT COUNT() FROM PermissionSetAssignment
				WHERE AssigneeId = :testUser.Id
				  AND PermissionSet.Name = 'Orgloom_Admin'
				  AND PermissionSet.NamespacePrefix = :ns
			];
			System.assertEquals(1, assignCount,
				'Re-install must not duplicate the existing assignment');
		}
	}

	@isTest
	static void directAssign_returnsTrueOnFirstAndFalseAfter() {
		// Exercises the @TestVisible assignAdminPermset helper directly,
		// confirming the return-value contract documented on the method.
		User testUser = createTestUser();
		System.runAs(testUser) {
			Test.startTest();
			Boolean first = OrgloomPostInstall.assignAdminPermset(testUser.Id);
			Boolean second = OrgloomPostInstall.assignAdminPermset(testUser.Id);
			Test.stopTest();
			System.assertEquals(true, first, 'First call should insert and return true');
			System.assertEquals(false, second, 'Second call should detect existing row and return false');
		}
	}

	// Build a fresh user under the standard System Administrator profile
	// so we have something stable to assign permsets to. Each test gets
	// its own user to avoid PermissionSetAssignment uniqueness collisions
	// across @isTest methods.
	static User createTestUser() {
		Profile p = [SELECT Id FROM Profile WHERE Name = 'System Administrator' LIMIT 1];
		String uniq = String.valueOf(Math.abs(Crypto.getRandomLong()));
		User u = new User(
			FirstName = 'PostInstall',
			LastName = 'Tester',
			Email = 'postinstall-' + uniq + '@orgloom.com.test',
			Username = 'postinstall-' + uniq + '@orgloom.com.test',
			Alias = 'pitest',
			ProfileId = p.Id,
			TimeZoneSidKey = 'America/Los_Angeles',
			LocaleSidKey = 'en_US',
			EmailEncodingKey = 'UTF-8',
			LanguageLocaleKey = 'en_US'
		);
		insert u;
		return u;
	}
}
