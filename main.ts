import { App, Notice, Plugin, PluginSettingTab, Setting, SuggestModal } from 'obsidian';

interface JournalMdSettings {
	automaticDateHeadings: boolean;
	headingDateFormat: string;
	locale: string | null;
	journalNotePath: string;
}

const DEFAULT_SETTINGS: JournalMdSettings = {
	automaticDateHeadings: true,
	headingDateFormat: "YYYY-MM-DD (ddd)",
	locale: null,
	journalNotePath: "Journal"
}

export default class JournalMd extends Plugin {
	settings: JournalMdSettings;

	get locale() {
		return this.settings.locale ?? window.moment.locale();
	}

	get noteName() {
		return this.settings.journalNotePath;
	}
	get notePath() {
		return this.settings.journalNotePath + ".md";
	}

	async getJournalNote() {
		const path = this.notePath;
		let note = this.app.vault.getFileByPath(path);
		if (!note) {
			new Notice(`Journal note at ${path} not found. Creating it now.`);
			await this.app.vault.createFolder(path.split("/").slice(0, -1).join("/"));
			note = await this.app.vault.create(path, "");
		}
		return note;
	}

	async openJournalNote() {
		const note = await this.getJournalNote();
		this.app.workspace.getLeaf(false).openFile(note);
	}

	async insertDateHeading() {
		const note = await this.getJournalNote();
		const date = window.moment().locale(this.locale).format(this.settings.headingDateFormat);

		const headings = this.app.metadataCache.getFileCache(note)?.headings ?? [];
		const firstHeading = headings[0];

		if (firstHeading?.heading === date && firstHeading?.level === 1) {
			return;
		}

		const heading = `# ${date}\n`;
		const content = await this.app.vault.read(note);

		// for all we know the file was changed outside of Obsidian so let's play it safe
		if (content.startsWith(heading)) {
			return;
		}

		await this.app.vault.modify(note, `${heading}${content}`);
	}

	async appendToLastEntry(text: string) {
		const note = await this.getJournalNote();
		const cache = this.app.metadataCache.getFileCache(note);
		const headings = cache?.headings;
		let offset = headings?.[1]?.position?.start?.offset;

		const content = await this.app.vault.read(note);
		offset ??= content.length;

		let before = content.slice(0, offset);
		const after = content.slice(offset);

		const firstHeadingEnd = headings?.[0]?.position?.end?.offset;
		if (firstHeadingEnd && before.slice(firstHeadingEnd).trim() === "") {
			before = before.slice(0, firstHeadingEnd);
		}

		await this.app.vault.modify(note, `${before}\n${text}\n${after}`);
	}

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("notebook", "Journal", () => this.openJournalNote());

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: "open-journal-note",
			name: "Open journal",
			callback: () => this.openJournalNote()
		});

		this.addCommand({
			id: "quick-append-to-journal",
			name: "Quick append to journal",
			callback: async () => {
				try {
					const text = await getTextToAppend(this.app);
					await this.appendToLastEntry(text);
				} catch (e) {
					// user cancelled
				}
			}
		});

		this.registerObsidianProtocolHandler("journal/open", async ({ text }) => {
			await this.openJournalNote();
		});
		this.registerObsidianProtocolHandler("journal/append", async ({ text }) => {
			await this.appendToLastEntry(text);
			await this.openJournalNote();
		});


		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new JournalMdSettingTab(this.app, this));

		// automatically insert a date heading
		this.app.workspace.on("file-open", async (file) => {
			if (this.settings.automaticDateHeadings && file?.path === this.notePath) {
				this.insertDateHeading();
			}
		});
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class JournalMdSettingTab extends PluginSettingTab {
	plugin: JournalMd;

	constructor(app: App, plugin: JournalMd) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Automatically create date headings")
			.setDesc("Will automatically create date headings in the journal file.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.automaticDateHeadings)
				.onChange(async (value) => {
					this.plugin.settings.automaticDateHeadings = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Heading date format")
			.setDesc((() => {
				const i = document.createDocumentFragment();
				i.appendText("For more syntax, refer to ");
				i.createEl(
					"a", {
					text: "format reference",
					attr: {
						href: "https://momentjs.com/docs/#/displaying/format/",
						target: "_blank"
					}
				});
				return i;
			})())
			.addMomentFormat(format => format
				.setDefaultFormat(DEFAULT_SETTINGS.headingDateFormat)
				.setValue(this.plugin.settings.headingDateFormat)
				.onChange(async (value) => {
					this.plugin.settings.headingDateFormat = value;
					await this.plugin.saveSettings();
				})
			);



		new Setting(containerEl)
			.setName("Heading date locale")
			.addDropdown(dropdown => dropdown
				.addOption("", "Use Obsidian language")
				.addOptions(
					Object.fromEntries(window.moment.locales().sort().map(locale => [locale, locale]))
				)
				.setValue(this.plugin.settings.locale ?? "")
				.onChange(async (value) => {
					if (value === "") {
						this.plugin.settings.locale = null;
					} else {
						this.plugin.settings.locale = value;
					}
				})
			);

		new Setting(containerEl)
			.setName("Journal note")
			.setDesc("This note will be used as the journal.")
			.addText(text => text
				.setPlaceholder("Journal")
				.setValue(this.plugin.settings.journalNotePath)
				.onChange(async (value) => {
					this.plugin.settings.journalNotePath = value;
					await this.plugin.saveSettings();
				})
			);
	}
}

class AppendToJournalModal extends SuggestModal<string> {
	getSuggestions(query: string): string[] {
		if (query.length == 0) {
			return [];
		} else {
			return [query];
		}
	}

	renderSuggestion(value: string, el: HTMLElement) {
		el.appendText(value);
	}

	onChooseSuggestion(item: string, evt: MouseEvent | KeyboardEvent) {
		this.resolve(item);
		this.resolved = true;
	}

	onClose() {
		setTimeout(() => {
			if (!this.resolved) {
				this.reject();
			}
		}, 1000);
	}

	resolved = false;

	resolve: (value?: string | PromiseLike<string>) => void;
	reject: (reason?: string) => void;

	constructor(app: App, resolve: (value?: string | PromiseLike<string>) => void, reject: (reason?: string) => void) {
		super(app);
		this.resolve = resolve;
		this.reject = reject;

		this.setPlaceholder("Append to journal...");
		this.emptyStateText = "...";
	}
}

function getTextToAppend(app: App): Promise<string> {
	return new Promise((resolve, reject) => {
		new AppendToJournalModal(app, resolve, reject).open();
	});
}