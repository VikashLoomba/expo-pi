import { Updater, Utils } from 'electrobun/main';

const NAME = 'InfiniChat';

/**
 * Updates from the GitHub release the app was built against (`release.baseUrl`), in the order Electrobun's Updater
 * takes them (apis/updater): check, download, then apply once `updateReady`. The update downloads before the app asks,
 * so Install and Relaunch is immediate. Applying asks the `before-quit` handlers, and the app's handler refuses the
 * first ask while it closes its links, which the Updater takes as a cancel; so the app shuts down first, and the ask
 * that follows is allowed. A dev build's Updater never reports an update.
 */
export class MacUpdates {
  private running?: Promise<void>;

  constructor(private readonly shutDown: () => Promise<void>) {}

  /** Checks once at a time; `quiet`, as at launch, shows nothing unless an update is ready to install. */
  check(quiet: boolean): Promise<void> {
    this.running ??= this.run(quiet).catch((error: unknown) => console.error(error)).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(quiet: boolean): Promise<void> {
    const checked = await Updater.checkForUpdate();
    if (checked.error) {
      if (!quiet) await failed(checked.error);
      return;
    }
    if (!checked.updateAvailable) {
      if (!quiet) await upToDate(await Updater.localInfo.version());
      return;
    }
    await Updater.downloadUpdate();
    const ready = Updater.updateInfo();
    if (!ready.updateReady) {
      if (!quiet) await failed(ready.error || 'The update could not be downloaded.');
      return;
    }
    const { response } = await Utils.showMessageBox({
      type: 'info',
      message: `A new version of ${NAME} is available.`,
      detail: `${NAME} ${ready.version} is ready to install. ${NAME} will quit and open again.`,
      buttons: ['Install and Relaunch', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    await this.shutDown().catch((error: unknown) => console.error(error));
    await Updater.applyUpdate();
    // The Updater quits once its helper is armed; if it couldn't, the app has closed its links and quits anyway.
    const last = Updater.getStatusHistory().at(-1);
    if (last?.status === 'error') await failed(last.details?.errorMessage ?? last.message);
    Utils.quit();
  }
}

function failed(reason: string) {
  return Utils.showMessageBox({
    type: 'warning', message: `${NAME} couldn’t update.`, detail: reason, buttons: ['OK'],
  });
}

function upToDate(version: string) {
  return Utils.showMessageBox({
    type: 'info', message: 'You’re up to date.', detail: `${NAME} ${version} is the newest version available.`,
    buttons: ['OK'],
  });
}
