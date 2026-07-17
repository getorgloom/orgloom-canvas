// Optional promo / referral / attribution code captured at signup. Free
// text, no validation here: the field is whatever the user typed (after
// trim + uppercasing). Primarily used to tag a cohort (newsletter
// referral, influencer partnership, ad campaign code) so we can later
// segment retention / conversion analytics by source. NOT a discount or
// billing field; Stripe coupons aren't touched at this layer.
//
// Numbered 032 because the migrator runs the canvas + saas migration
// dirs as one alphabetically-ordered set; the saas dir already reaches
// 031 (031_workspace_cap_toggles), so a new migration must sort after
// that to satisfy Kysely's "names must come alphabetically after the
// last executed migration" rule.
//
// Index because we'll want to GROUP BY promo_code in admin queries
// ("how many accounts came in under code RAMPUP26?") and that gets
// expensive on a full table scan as the account list grows.

export async function up(db) {
	await db.schema
		.alterTable("accounts")
		.addColumn("promo_code", "text")
		.execute();
	await db.schema
		.createIndex("accounts_promo_code_idx")
		.on("accounts")
		.column("promo_code")
		.execute();
}

export async function down(db) {
	await db.schema.dropIndex("accounts_promo_code_idx").execute();
	await db.schema.alterTable("accounts").dropColumn("promo_code").execute();
}
