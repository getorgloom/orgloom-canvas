/**
 * Tests for AuditEventGuard trigger. Verifies:
 *   - A Standard User WITHOUT Orgloom_Admin can INSERT Audit_Event__c
 *     rows (via Orgloom_User perm set), but UPDATE and DELETE both
 *     throw with the expected "append-only" error.
 *   - A Standard User WITH Orgloom_Admin can UPDATE and DELETE freely.
 *
 * Same testSetup pattern UploadPromoterTest/UploadRecallerTest use:
 * @testSetup creates two Standard Users (one perm set each), every
 * test method wraps its DML in System.runAs(thatUser) so trigger
 * runs under realistic non-sysadmin permissions.
 */
@isTest
private class AuditEventGuardTest {

    // Resolve THIS deployment's namespace so permset lookups pin the same
    // permission set the trigger honors. An org can contain BOTH the
    // managed package (namespaced permsets) and unpackaged source (null
    // namespace); a namespace-blind LIMIT 1 would nondeterministically
    // grab either.
    private static String pkgNamespace() {
        String cls = OrgloomKekService.class.getName();
        return cls.contains('.') ? cls.substringBefore('.') : null;
    }

    private static String userUsername() {
        return 'orgloom-audit-user@' + UserInfo.getOrganizationId() + '.test';
    }

    private static String adminUsername() {
        return 'orgloom-audit-admin@' + UserInfo.getOrganizationId() + '.test';
    }

    private static String smokeUsername() {
        return 'orgloom-audit-smoke@' + UserInfo.getOrganizationId() + '.test';
    }

    @testSetup
    static void setupUsers() {
        Profile p = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];

        // Non-admin runner (Orgloom_User perm set only).
        String un = 'orgloom-audit-user@' + UserInfo.getOrganizationId() + '.test';
        User u = new User(
            FirstName = 'Orgloom',
            LastName = 'AuditUser',
            Email = un,
            Alias = 'oaudusr',
            Username = un,
            EmailEncodingKey = 'UTF-8',
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US',
            TimeZoneSidKey = 'America/Los_Angeles',
            ProfileId = p.Id
        );
        insert u;

        String ns = pkgNamespace();
        PermissionSet userPs = [
            SELECT Id FROM PermissionSet
            WHERE Name = 'Orgloom_User'
              AND NamespacePrefix = :ns
            LIMIT 1
        ];
        insert new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = userPs.Id);

        // Admin runner (Orgloom_Admin perm set).
        String an = 'orgloom-audit-admin@' + UserInfo.getOrganizationId() + '.test';
        User a = new User(
            FirstName = 'Orgloom',
            LastName = 'AuditAdmin',
            Email = an,
            Alias = 'oaudadm',
            Username = an,
            EmailEncodingKey = 'UTF-8',
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US',
            TimeZoneSidKey = 'America/Los_Angeles',
            ProfileId = p.Id
        );
        insert a;

        PermissionSet adminPs = [
            SELECT Id FROM PermissionSet
            WHERE Name = 'Orgloom_Admin'
              AND NamespacePrefix = :ns
            LIMIT 1
        ];
        insert new PermissionSetAssignment(AssigneeId = a.Id, PermissionSetId = adminPs.Id);

        // CRUD-but-not-admin runner: a permset granting full object CRUD
        // on Audit_Event__c WITHOUT Orgloom_Admin or Modify All Data. This
        // user sails past the perm-set CRUD layer and hits the TRIGGER's
        // block, deterministically exercising the addError path. Built
        // programmatically (not the dev-only Orgloom_Audit_Smoke_Test
        // permset, which is .forceignore'd and absent from packaged orgs).
        // All setup-object DML, so it can live in @testSetup.
        String sn = 'orgloom-audit-smoke@' + UserInfo.getOrganizationId() + '.test';
        User s = new User(
            FirstName = 'Orgloom',
            LastName = 'AuditSmoke',
            Email = sn,
            Alias = 'oaudsmk',
            Username = sn,
            EmailEncodingKey = 'UTF-8',
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US',
            TimeZoneSidKey = 'America/Los_Angeles',
            ProfileId = p.Id
        );
        insert s;

        PermissionSet crudPs = new PermissionSet(
            Name = 'Orgloom_Audit_Crud_TestOnly',
            Label = 'Orgloom Audit CRUD (test-only)'
        );
        insert crudPs;
        // Object API name needs this deployment's namespace prefix when
        // running inside the packaged namespace.
        String objApiName = (ns == null ? '' : ns + '__') + 'Audit_Event__c';
        insert new ObjectPermissions(
            ParentId = crudPs.Id,
            SobjectType = objApiName,
            PermissionsRead = true,
            PermissionsCreate = true,
            PermissionsEdit = true,
            PermissionsDelete = true,
            PermissionsViewAllRecords = true,
            PermissionsModifyAllRecords = true
        );
        insert new PermissionSetAssignment(AssigneeId = s.Id, PermissionSetId = crudPs.Id);
    }

    private static User user() {
        return [SELECT Id FROM User WHERE Username = :userUsername() LIMIT 1];
    }

    private static User admin() {
        return [SELECT Id FROM User WHERE Username = :adminUsername() LIMIT 1];
    }

    private static User smokeUser() {
        return [SELECT Id FROM User WHERE Username = :smokeUsername() LIMIT 1];
    }

    // Helper: build a minimally-valid Audit_Event__c. Required fields
    // (External_Id__c, Action__c, Status__c, Actor_Kind__c, Recorded_At__c)
    // must all be populated.
    private static Audit_Event__c sampleEvent(String externalId) {
        return new Audit_Event__c(
            External_Id__c = externalId,
            Action__c = 'upload',
            Status__c = 'ok',
            Actor_Kind__c = 'web',
            Recorded_At__c = DateTime.now()
        );
    }

    @isTest
    static void nonAdminCanInsert() {
        // Inserts are allowed (Orgloom_User has Create on the object,
        // and the trigger doesn't fire on insert).
        Test.startTest();
        System.runAs(user()) {
            Audit_Event__c ae = sampleEvent('audit_test_insert_1');
            insert ae;
            System.assertNotEquals(null, ae.Id, 'Insert should succeed for non-admin');
        }
        Test.stopTest();
    }

    // Defense-in-depth: non-admin DML must fail. Two layers can block:
    //   1. The Orgloom_User perm set grants Create + Read only (no
    //      Edit/Delete CRUD on Audit_Event__c); this fires FIRST,
    //      producing INSUFFICIENT_ACCESS_* errors before the trigger
    //      gets a chance to run.
    //   2. The AuditEventGuard trigger blocks UPDATE/DELETE with an
    //      "append-only" message, kicking in for anyone who somehow
    //      had CRUD edit/delete granted (e.g., a future profile
    //      change or a sysadmin who hasn't been re-permed).
    // We accept either rejection path: either layer blocking the
    // mutation is the security property we care about.
    private static Boolean isBlockedByPolicy(DmlException e) {
        String msg = e.getMessage();
        return msg.contains('append-only')              // trigger
            || msg.contains('INSUFFICIENT_ACCESS')      // perm-set CRUD
            || msg.contains('insufficient access');     // case variants
    }

    @isTest
    static void nonAdminCannotUpdate() {
        // Pre-seed as admin so the row exists, then attempt update
        // as the non-admin user.
        Audit_Event__c seed = sampleEvent('audit_test_update_1');
        System.runAs(admin()) {
            insert seed;
        }
        Test.startTest();
        System.runAs(user()) {
            seed.Action__c = 'tampered';
            try {
                update seed;
                System.assert(false, 'Update should have been blocked for non-admin');
            } catch (DmlException e) {
                System.assert(
                    isBlockedByPolicy(e),
                    'Update should be blocked by perm-set CRUD or trigger; got: ' + e.getMessage()
                );
            }
        }
        Test.stopTest();
    }

    @isTest
    static void nonAdminCannotDelete() {
        Audit_Event__c seed = sampleEvent('audit_test_delete_1');
        System.runAs(admin()) {
            insert seed;
        }
        Test.startTest();
        System.runAs(user()) {
            try {
                delete seed;
                System.assert(false, 'Delete should have been blocked for non-admin');
            } catch (DmlException e) {
                System.assert(
                    isBlockedByPolicy(e),
                    'Delete should be blocked by perm-set CRUD or trigger; got: ' + e.getMessage()
                );
            }
        }
        Test.stopTest();
    }

    @isTest
    static void crudUserWithoutAdmin_isBlockedByTriggerOnUpdate() {
        // The smoke user HAS object CRUD, so the perm-set layer passes and
        // the TRIGGER must be the one that blocks: assert its specific
        // append-only message (not the either-layer acceptance above).
        Audit_Event__c seed = sampleEvent('audit_test_trigger_update');
        System.runAs(admin()) {
            insert seed;
        }
        Test.startTest();
        System.runAs(smokeUser()) {
            seed.Action__c = 'tampered-past-crud';
            try {
                update seed;
                System.assert(false, 'Trigger should have blocked the update');
            } catch (DmlException e) {
                System.assert(
                    e.getMessage().contains('Activity History rows are protected'),
                    'Expected the trigger\'s protected-history block, got: ' + e.getMessage()
                );
            }
        }
        Test.stopTest();
    }

    @isTest
    static void crudUserWithoutAdmin_isBlockedByTriggerOnDelete() {
        Audit_Event__c seed = sampleEvent('audit_test_trigger_delete');
        System.runAs(admin()) {
            insert seed;
        }
        Test.startTest();
        System.runAs(smokeUser()) {
            try {
                delete seed;
                System.assert(false, 'Trigger should have blocked the delete');
            } catch (DmlException e) {
                System.assert(
                    e.getMessage().contains('Activity History rows are protected'),
                    'Expected the trigger\'s protected-history block, got: ' + e.getMessage()
                );
            }
        }
        Test.stopTest();
    }

    @isTest
    static void adminCanUpdate() {
        Audit_Event__c seed = sampleEvent('audit_test_admin_update');
        System.runAs(admin()) {
            insert seed;
        }
        Test.startTest();
        System.runAs(admin()) {
            seed.Action__c = 'updated_by_admin';
            update seed;
            Audit_Event__c reloaded = [SELECT Action__c FROM Audit_Event__c WHERE Id = :seed.Id];
            System.assertEquals('updated_by_admin', reloaded.Action__c, 'Admin update should persist');
        }
        Test.stopTest();
    }

    @isTest
    static void adminCanDelete() {
        Audit_Event__c seed = sampleEvent('audit_test_admin_delete');
        System.runAs(admin()) {
            insert seed;
        }
        Test.startTest();
        System.runAs(admin()) {
            delete seed;
            List<Audit_Event__c> remaining = [SELECT Id FROM Audit_Event__c WHERE Id = :seed.Id];
            System.assertEquals(0, remaining.size(), 'Admin delete should remove the row');
        }
        Test.stopTest();
    }
}
