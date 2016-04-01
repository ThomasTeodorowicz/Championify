import Promise from 'bluebird';
import glob from 'glob';
import path from 'path';
import R from 'ramda';

import { cl, request, spliceVersion, updateProgressBar } from './helpers';

import ChampionifyErrors from './errors';
import champgg from './sources/championgg';
import Log from './logger';
import lolflavor from './sources/lolflavor';
import optionsParser from './options_parser';
import preferences from './preferences';
import permissions from './permissions';
import store from './store';
import T from './translate';

const fs = Promise.promisifyAll(require('fs-extra'));

// Windows Specific Dependencies
let runas;
if (process.platform === 'win32') runas = require('runas');

/**
 * Saves settings/options from the frontend.
 * @returns {Promise}
*/
function saveSettings() {
  return preferences.save();
}

/**
 * Gets the latest Riot Version.
 * @returns {Promise.<String| ChampionifyErrors.RequestError>} Riot version.
*/
function getRiotVer() {
  if (store.get('importing')) cl(`${T.t('lol_version')}`);
  return request({url: 'https://ddragon.leagueoflegends.com/realms/na.json', json: true})
    .then(R.prop('v'))
    .tap(version => store.set('riot_ver', version))
    .catch(err => {
      throw new ChampionifyErrors.RequestError('Can\'t get Riot Version').causedBy(err);
    });
}

/**
 * Downloads all available champs from Riot.
 * @returns {Promise.<Array|ChampionifyErrors.RequestError>} Array of Champions in Riot's data schema.
*/
function getChamps() {
  cl(`${T.t('downloading_champs')}`);
  const params = {
    url: `http://ddragon.leagueoflegends.com/cdn/${store.get('riot_ver')}/data/${T.riotLocale()}/champion.json`,
    json: true
  };

  return request(params)
    .then(R.prop('data'))
    .tap(data => {
      if (!data) throw new ChampionifyErrors.RequestError('Can\'t get Champs');
      T.merge(R.zipObj(R.keys(data), R.pluck('name')(R.values(data))));

      store.set('manaless', R.pluck('id')(R.filter(champ => champ.partype !== 'Mana')));
      store.set('champs', R.keys(data).sort());
    })
    .catch(err => {
      if (err instanceof ChampionifyErrors.ChampionifyError) throw err;
      new ChampionifyErrors.RequestError('Can\'t get Champs').causedBy(err);
    });
}

/**
 * Deletes all previous Championify builds from client.
 * @param {Boolean} [false]
 * @returns {Promise}
 */

function deleteOldBuilds(deletebtn) {
  if (store.get('settings') && store.get('settings').dontdeleteold) return Promise.resolve();

  cl(T.t('deleting_old_builds'));
  const globbed = [
    glob.sync(`${store.get('itemset_path')}**/CGG_*.json`),
    glob.sync(`${store.get('itemset_path')}**/CIFY_*.json`)
  ];

  return Promise.resolve(R.flatten(globbed))
    .each(f => fs.unlinkAsync(f))
    .catch(err => Log.warn(err))
    .then(() => {
      if (deletebtn === true) updateProgressBar(2.5);
    });
}


/**
 * Saves all compiled item sets to file, creating paths included.
 * @returns {Promise}
 */

function saveToFile() {
  return Promise.resolve([store.get('sr_itemsets'), store.get('aram_itemsets')])
    .then(R.flatten)
    .then(R.reject(R.isNil))
    .each(data => {
      const itemset_data = JSON.stringify(data.riot_json, null, 4);
      const folder_path = path.join(store.get('itemset_path'), data.champ, 'Recommended');
      const file_path = path.join(folder_path, `CIFY_${data.champ}_${data.file_prefix}.json`);

      return fs.mkdirsAsync(folder_path)
        .catch(err => Log.warn(err))
        .then(() => fs.writeFileAsync(file_path, itemset_data, 'utf8'))
        .catch(err => {
          throw new ChampionifyErrors.FileWriteError('Failed to write item set json file').causedBy(err);
        });
    });
}

/**
 * Resave preferences with new local version
 * @returns {Promise}
 */

function resavePreferences() {
  const prefs = preferences.get();
  prefs.local_is_version = spliceVersion(store.get('riot_ver'));
  return preferences.save(prefs);
}


/**
 * Set windows permissions if required
 * @returns {Promise}
 */

function setWindowsPermissions() {
  if (process.platform === 'win32' && optionsParser.runnedAsAdmin()) {
    cl(T.t('resetting_file_permission'));
    const champ_files = glob.sync(path.join(store.get('itemset_path'), '**'));
    return permissions.setWindowsPermissions(champ_files);
  }
}


/**
 * Main function that starts up all the magic.
 * @returns {Promise}
 */

function downloadItemSets() {
  store.set('importing', true);
  store.set('settings', preferences.get().options);
  store.remove('sr_itemsets');
  store.remove('aram_itemsets');

  updateProgressBar(true);

  const toProcess = [];
  if (store.get('settings').aram) toProcess.push(lolflavor.getAram);
  if (store.get('settings').sr_source === 'lolflavor') {
    toProcess.push(lolflavor.getSr);
  } else {
    toProcess.push(champgg.getSr);
  }

  return saveSettings()
    .then(permissions.championTest)
    .then(getRiotVer)
    .then(getChamps)
    .then(() => Promise.all(R.map(fn => fn(), toProcess)))
    .then(deleteOldBuilds)
    .then(saveToFile)
    .then(resavePreferences)
    .then(setWindowsPermissions)
    .then(() => {
      store.set('importing', false);
      updateProgressBar(10);
    })
    .catch(err => {
      Log.error(err);
      if (err instanceof ChampionifyErrors.FileWriteError && process.platform === 'win32' && !optionsParser.runnedAsAdmin()) {
        return runas(process.execPath, ['--startAsAdmin', '--import'], {
          hide: false,
          admin: true
        });
      }

      // If not a file write error, end session.
      throw err;
    });
}

/**
 * Export.
 */
export default {
  run: downloadItemSets,
  delete: deleteOldBuilds,
  getVersion: getRiotVer
};
