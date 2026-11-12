import { defineActivities } from "@tatara/temporal";

export default defineActivities({
	// the name is the activity type, unique in the app; a retry runs it again, so keep it idempotent
	async __moduleCamel____namePascal__(id: string): Promise<void> {
		void id;
	},
});
