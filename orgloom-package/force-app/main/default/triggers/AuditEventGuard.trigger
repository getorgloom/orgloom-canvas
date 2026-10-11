/**
 * Accidental-mutation guard for Audit_Event__c Activity History rows.
 *
 * Permission-set object CRUD already restricts edit/delete on this object
 * to users with the Orgloom_Admin perm set. This trigger is belt-and-
 * suspenders: it hard-blocks UPDATE and DELETE in the database tier so
 * even an admin's accidental Data Loader UPDATE, a sysadmin without the
 * perm set, or a future Apex/Flow that bypassed perm-set CRUD can't
 * silently mutate the audit trail.
 *
 * Allowed actors (any one of):
 *   - User has the Orgloom_Admin permission set assigned
 *   - User has the system "Modify All Data" permission (sysadmin et al)
 * Everyone else gets a blocking addError() on the affected row.
 *
 * Note: this DOES NOT prevent Orgloom_Admin or Modify All Data users from
 * rewriting history. There is no cryptographic chain for these rows. The
 * trigger is defense-in-depth against accidental or unauthorized ordinary-
 * user mutation, not a compliance-grade integrity proof.
 */
trigger AuditEventGuard on Audit_Event__c (before update, before delete) {
    // Resolve THIS package's namespace at runtime so the permset match
    // below can't be satisfied by a subscriber-created permission set
    // that merely shares the name 'Orgloom_Admin'. Without the
    // NamespacePrefix filter, anyone with "Manage Profiles and
    // Permission Sets" (a lower privilege than Modify All Data) could
    // mint a look-alike permset, assign it to themselves, and silently
    // bypass this guard. getName() returns 'ns.ClassName' when packaged
    // and bare 'ClassName' in scratch/unpackaged orgs, so the same code
    // works in both (null namespace matches the unpackaged permset).
    String guardClsName = OrgloomKekService.class.getName();
    String guardNs = guardClsName.contains('.')
        ? guardClsName.substringBefore('.')
        : null;

    // One query per transaction: cheap. PermissionSetAssignment is the
    // canonical source for both explicit perm-set grants and the system
    // ModifyAllData permission (sysadmin profiles materialize as a
    // PermissionSet row).
    // This query intentionally runs in system mode because it is itself the
    // authorization check. A non-admin user normally cannot query setup-object
    // assignments in user mode; enforcing that user's CRUD here would prevent
    // the trigger from determining whether the packaged admin permission set is
    // present. The query is fixed, scoped to UserInfo.getUserId(), returns at
    // most one Id, and never exposes assignment data to the caller.
    // code-analyzer-suppress-next-line pmd:ApexCRUDViolation
    Boolean canMutate = ![
        SELECT Id
        FROM PermissionSetAssignment
        WHERE AssigneeId = :UserInfo.getUserId()
          AND (
              (
                  PermissionSet.Name = 'Orgloom_Admin'
                  AND PermissionSet.NamespacePrefix = :guardNs
              )
              OR PermissionSet.PermissionsModifyAllData = true
          )
        LIMIT 1
    ].isEmpty();

    if (canMutate) return;

    // Block. addError on each row is the documented pattern; Salesforce
    // will roll back the whole DML batch with the message on the offending
    // record(s). Message is intentionally precise so the user knows
    // exactly why their edit/delete was blocked and how to escalate.
    String msg =
		'Org Loom Activity History rows are protected from ordinary-user edits. ' +
        'Updates and deletes require the Orgloom_Admin permission set ' +
        '(or Modify All Data). ' +
        'Contact your Salesforce admin to grant access if this denial is unexpected.';
    List<Audit_Event__c> targets =
        Trigger.isUpdate ? Trigger.new : Trigger.old;
    for (Audit_Event__c ae : targets) {
        ae.addError(msg);
    }
}
