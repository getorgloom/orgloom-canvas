
import jsforce from 'jsforce';
import { config } from 'orgloom-canvas/config';

const { OAuth2 } = jsforce;

export function createOAuth2(loginUrlOverride) {
	const cleaned = (loginUrlOverride || config.salesforce.loginUrl || '').trim();
	return new OAuth2({
		loginUrl: cleaned || 'https://login.salesforce.com',
		clientId: config.salesforce.clientId,
		clientSecret: config.salesforce.clientSecret,
		redirectUri: config.salesforce.redirectUri,
	});
}
