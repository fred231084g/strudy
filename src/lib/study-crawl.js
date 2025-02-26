/**
 * The crawl analyzer takes a crawl report as input and creates a report that
 * contains, for each spec, a list of potential anomalies, such as:
 *
 * 1. specs that do not seem to reference any other spec normatively;
 * 2. specs that define WebIDL terms but do not normatively reference the WebIDL
 * spec;
 * 3. specs that contain invalid WebIDL terms definitions;
 * 4. specs that use obsolete WebIDL constructs (e.g. `[]` instead of
 * `FrozenArray`);
 * 5. specs that define WebIDL terms that are *also* defined in another spec;
 * 6. specs that use WebIDL terms defined in another spec without referencing
 * that spec normatively;
 * 7. specs that use WebIDL terms for which the crawler could not find any
 * definition in any of the specs it studied;
 * 8. specs that link to another spec but do not include a reference to that
 * other spec;
 * 9. specs that link to another spec inconsistently in the body of the document
 * and in the list of references (e.g. because the body of the document
 * references the Editor's draft while the reference is to the latest published
 * version).
 * 10. W3C specs that do not have a known Editor's Draft
 *
 * @module analyzer
 */

const fs = require('fs');
const path = require('path');
const requireFromWorkingDirectory = require('./require-cwd');
const { expandCrawlResult, isLatestLevelThatPasses } = require('reffy');
const { studyBackrefs } = require('./study-backrefs');
const checkMissingDefinitions = require('../cli/check-missing-dfns').checkSpecDefinitions;

const {canonicalizeUrl, canonicalizesTo} = require("./canonicalize-url");

const array_concat = (a,b) => a.concat(b);
const uniqueFilter = (item, idx, arr) => arr.indexOf(item) === idx;

/**
 * Helper function that returns true when the given URL seems to target a real
 * "spec" (as opposed to, say, a Wiki page, or something else)
 */
const matchSpecUrl = url =>
  url.match(/spec.whatwg.org/) ||
  url.match(/www.w3.org\/TR\/[a-z0-9]/) ||
  (url.match(/w3c.github.io/) && ! url.match(/w3c.github.io\/test-results\//));


/**
 * Compares specs for ordering by title
 */
const byTitle = (a, b) =>
  (a.title || '').toUpperCase().localeCompare((b.title || '').toUpperCase());


/**
 * Returns true when the given error array is not set or does not contain any
 * error.
 */
function isOK(errors) {
  return !errors || (errors.length === 0);
}


/**
 * Filter out spec info parameters that are not needed when the spec is to
 * appear as a reference in the final report, to keep the JSON report somewhat
 * readable.
 *
 * @function
 * @param {Object} spec The spec info to filter, typically the spec object
 *   contained in the results of a crawl.
 * @return {Object} A new spec object that only contains the URL, title, the
 *   URL that was crawled.
 */
function filterSpecInfo(spec) {
  return {
    url: spec.url,
    title: spec.title,
    crawled: spec.crawled
  };
}


/**
 * Analyze the result of a crawl and produce a report that can easily be
 * converted without more processing to a human readable version.
 *
 * @function
 * @param {Array(Object)} A crawl result, one entry per spec
 * @param {Array(Object)} An optional list of specs to include in the report.
 *   All specs are included by default.
 * @return {Array(Object)} A report, one entry per spec, each spec will have
 *   a "report" property with "interesting" properties, see code comments inline
 *   for details
 */
function studyCrawlResults(results, options = {}) {
  const knownIdlNames = results
    .map(r => r.idlparsed?.idlNames ? Object.keys(r.idlparsed.idlNames) : [], [])
    .reduce(array_concat)
    .filter(uniqueFilter);
  const knownGlobalNames = results
    .map(r => r.idlparsed?.globals ? Object.keys(r.idlparsed.globals) : [], [])
    .reduce(array_concat)
    .filter(uniqueFilter);
  const idlNamesIndex = {};
  knownIdlNames.forEach(name =>
    idlNamesIndex[name] = results.filter(spec =>
      isLatestLevelThatPasses(spec, results, s =>
        s.idlparsed?.idlNames?.[name])));

  // WebIDL-1 only kept for historical reasons to process old crawl results
  const WebIDLSpec = results.find(spec =>
    spec.shortname === 'webidl' || spec.shortname === 'WebIDL-1') || {};

  const sortedResults = results.sort(byTitle);

  // Construct spec equivalence from the crawl report, which should be more
  // complete than the initial equivalence list.
  const specEquivalents = {};
  sortedResults.forEach(spec =>
    spec.versions.forEach(v => {
      if (specEquivalents[v]) {
        if (Array.isArray(specEquivalents[v])) {
          specEquivalents[v].push(spec.url);
        }
        else {
          specEquivalents[v] = [specEquivalents[v], spec.url];
        }
      }
      else {
        specEquivalents[v] = spec.url;
      }
    }
  ));

  // Strong canonicalization options to find references
  var useEquivalents = {
    datedToLatest: true,
    equivalents: specEquivalents
  };

  const xrefsReport = studyBackrefs(sortedResults, options.trResults);

  const specsToInclude = options.include;
  return sortedResults
    .filter(spec => !specsToInclude ||
      (specsToInclude.length === 0) ||
      specsToInclude.some(toInclude =>
        toInclude === spec.shortname ||
        toInclude === spec.series?.shortname ||
        toInclude === spec.url ||
        toInclude === spec.crawled ||
        toInclude === spec.nightly?.url ||
        toInclude.shortname === spec.shortname ||
        toInclude.shortname === spec.series?.shortname ||
        (toInclude.url && toInclude.url === spec.url) ||
        (toInclude.url && toInclude.url === spec.crawled) ||
        (toInclude.url && toInclude.url === spec.nightly?.url) ||
        (toInclude.html && toInclude.html === spec.html)))
    .map(spec => {
      spec.idlparsed = spec.idlparsed || {};
      spec.css = spec.css || {};
      spec.refs = spec.refs || {};
      spec.links = spec.links || {};
      const idlDfns = spec.idlparsed.idlNames ?
        Object.keys(spec.idlparsed.idlNames) : [];
      const idlExtendedDfns = spec.idlparsed.idlExtendedNames ?
        Object.keys(spec.idlparsed.idlExtendedNames) : [];
      const idlDeps = spec.idlparsed.externalDependencies ?
        spec.idlparsed.externalDependencies : [];
      const exposed = spec.idlparsed.exposed ? Object.keys(spec.idlparsed.exposed) : [];

      const xrefs = xrefsReport[spec.url];
      if (xrefs) {
        // The backrefs analysis tool includes the spec's title in its
        // report, which we already have at the top level.
        delete xrefs.title;

        // The backrefs analysis tool also includes a list of documents
        // that look like specs but that are not crawled. That is not
        // an anomaly with the spec but rather a list of potential specs
        // to be included in browser-specs. They should be treated
        // separately.
        delete xrefs.unknownSpecs;
      }

      const report = {
        // An error at this level means the spec could not be parsed at all
        error: spec.error,

        // Whether the crawler found normative references
        // (most specs should have)
        noNormativeRefs: !spec.refs.normative ||
          (spec.refs.normative.length === 0),

        // Whether the spec normatively references the WebIDL spec
        // (all specs that define IDL content should)
        noRefToWebIDL: (spec !== WebIDLSpec) &&
          (spec.idlparsed.bareMessage || (idlDfns.length > 0) || (idlExtendedDfns.length > 0)) &&
          (!spec.refs.normative || !spec.refs.normative.find(ref =>
            ref.name.match(/^WebIDL/i) ||
            (ref.url === WebIDLSpec.url) ||
            (WebIDLSpec.nightly && (ref.url === WebIDLSpec.nightly.url)))),

        // Whether the spec has invalid IDL content
        // (the crawler cannot do much when IDL content is invalid, it
        // cannot tell what IDL definitions and references the spec
        // contains in particular)
        hasInvalidIdl: !!(!spec.idlparsed.idlNames && spec.idlparsed.bareMessage),

        // Whether the spec uses IDL constructs that were valid in
        // WebIDL Level 1 but no longer are, typically "[]" instead of
        // "FrozenArray"
        hasObsoleteIdl: spec.idlparsed.hasObsoleteIdl,

        // List of Exposed names used in the spec that we know nothing
        // about because we cannot find a matching "Global" name in
        // any other spec
        unknownExposedNames: exposed
          .filter(name => !knownGlobalNames.includes(name) && name !== "*")
          .sort(),

        // List of IDL names used in the spec that we know nothing about
        // (for instance because of some typo or because the term is
        // defined in a spec that has not been crawled or that could
        // not be parsed)
        unknownIdlNames: idlDeps
          .filter(name => knownIdlNames.indexOf(name) === -1)
          .sort(),

        // List of IDL definitions that are already defined in some
        // other crawled spec
        // (this should not happen, ideally)
        redefinedIdlNames: idlDfns
          .filter(name => (idlNamesIndex[name].length > 1))
          .map(name => {
            return {
              name,
              refs: idlNamesIndex[name].filter(ref => (ref.url !== spec.url)).map(filterSpecInfo)
            };
          }),

        // List of IDL names used in the spec that are defined in some
        // other spec, and which do not seem to appear in the list of
        // normative references
        // (There should always be an entry in the normative list of
        // references that links to that other spec)
        // NB: "Exposed=Window", which would in theory trigger the need
        // to add a normative reference to HTML, is considered to be
        // an exception to the rule, and ignored.
        missingWebIdlRef: idlDeps
          .filter(name => knownIdlNames.indexOf(name) !== -1)
          .map(name => {
            const refs = idlNamesIndex[name].map(filterSpecInfo);
            let ref = null;
            if (spec.refs && spec.refs.normative) {
              ref = refs.find(s => {
                const canon = canonicalizeUrl(s.url, useEquivalents);
                return !!spec.refs.normative.find(r =>
                  canonicalizesTo(r.url, canon, useEquivalents));
              });
            }
            return (ref ? null : { name, refs });
          })
          .filter(i => !!i),

        // CSS/IDL terms that do not have a corresponding dfn in the
        // specification
        missingDfns: checkMissingDefinitions(spec),

        // Links to external specifications within the body of the spec
        // that do not have a corresponding entry in the references
        // (all links to external specs should have a companion ref)
        missingLinkRef: Object.keys(spec.links)
          .filter(matchSpecUrl)
          .filter(l => {
            // Filter out "good" and "inconsistent" references
            const canon = canonicalizeUrl(l, useEquivalents);
            const refs = (spec.refs.normative || []).concat(spec.refs.informative || []);
            return !refs.find(r => canonicalizesTo(r.url, canon, useEquivalents));
          })
          .filter(l =>
            // Ignore links to other versions of "self". There may
            // be cases where it would be worth reporting them but
            // most of the time they appear in "changelog" sections.
            !canonicalizesTo(l, spec.url, useEquivalents) &&
            !canonicalizesTo(l, spec.versions, useEquivalents)
          ),

        // Links to external specifications within the body of the spec
        // that have a corresponding entry in the references, but for
        // which the reference uses a different URL, e.g. because the
        // link targets the Editor's Draft, whereas the reference
        // targets the latest published version
        inconsistentRef: Object.keys(spec.links)
          .filter(matchSpecUrl)
          .map(l => {
            const canonSimple = canonicalizeUrl(l);
            const canon = canonicalizeUrl(l, useEquivalents);
            const refs = (spec.refs.normative || []).concat(spec.refs.informative || []);

            // Filter out "good" references
            if (refs.find(r => canonicalizesTo(r.url, canonSimple))) {
              return null;
            }
            const ref = refs.find(r => canonicalizesTo(r.url, canon, useEquivalents));
            return (ref ? { link: l, ref } : null);
          })
          .filter(l => !!l),

        // Lists of specs present in the crawl report that reference
        // the current spec, either normatively or informatively
        // (used to produce the dependencies report)
        referencedBy: {
          normative: sortedResults
            .filter(s =>
              s.refs && s.refs.normative &&
              s.refs.normative.find(r =>
                canonicalizesTo(r.url, spec.url, useEquivalents) ||
                canonicalizesTo(r.url, spec.versions, useEquivalents)))
            .map(filterSpecInfo),
          informative: sortedResults
            .filter(s =>
              s.refs && s.refs.informative &&
              s.refs.informative.find(r =>
                canonicalizesTo(r.url, spec.url, useEquivalents) ||
                canonicalizesTo(r.url, spec.versions, useEquivalents)))
            .map(filterSpecInfo)
        },

        // Analysis of cross-references to other specs
        xrefs: xrefsReport[spec.url]
      };

      // A spec is OK if it does not contain anything "suspicious".
      report.ok = !report.error &&
        !report.noNormativeRefs &&
        !report.hasInvalidIdl &&
        !report.hasObsoleteIdl &&
        !report.noRefToWebIDL &&
        !report.missingDfns.obsoleteDfnsModel &&
        isOK(report.unknownIdlNames) &&
        isOK(report.redefinedIdlNames) &&
        isOK(report.missingWebIdlRef) &&
        isOK(report.missingDfns.css.filter(r => !r.warning)) &&
        isOK(report.missingDfns.idl.filter(r => !r.warning)) &&
        isOK(report.missingLinkRef) &&
        isOK(report.inconsistentRef) &&
        (!report.xrefs || (
          isOK(report.xrefs.notExported) &&
          isOK(report.xrefs.notDfn) &&
          isOK(report.xrefs.brokenLinks) &&
          isOK(report.xrefs.evolvingLinks) &&
          isOK(report.xrefs.outdatedSpecs) &&
          isOK(report.xrefs.datedUrls)));

      const res = {
        title: spec.title || spec.url,
        shortname: spec.shortname,
        date: spec.date,
        url: spec.url,
        release: spec.release,
        nightly: spec.nightly,
        crawled: spec.crawled,
        organization: spec.organization,
        groups: spec.groups,
        report
      };
      return res;
  });
}

async function studyCrawl(crawlResults, options = {}) {
  if (typeof crawlResults === 'string') {
    const crawlResultsPath = crawlResults;
    crawlResults = requireFromWorkingDirectory(crawlResults);
    crawlResults = await expandCrawlResult(crawlResults, path.dirname(crawlResultsPath));
  }
  else {
    crawlResults = crawlResults || {};
  }
  crawlResults.results = crawlResults.results || [];
  crawlResults.stats = crawlResults.stats || {};

  if (typeof options.trResults === 'string') {
    const crawlResultsPath = options.trResults;
    options.trResults = requireFromWorkingDirectory(options.trResults);
    options.trResults = await expandCrawlResult(options.trResults, path.dirname(crawlResultsPath));
    options.trResults = options.trResults.results;
  }

  const results = studyCrawlResults(crawlResults.results, options);

  return {
    type: 'study',
    title: crawlResults.title || 'Web specs analysis',
    description: crawlResults.description || '',
    date: crawlResults.date || (new Date()).toJSON(),
    stats: {
      crawled: crawlResults.stats.crawled || crawlResults.results.length,
      errors: crawlResults.stats.errors || crawlResults.results.filter(spec => !!spec.error).length,
      studied: results.length || crawlResults.stats.crawled
    },
    results: results
  };
}


/**************************************************
Export methods for use as module
**************************************************/
module.exports.studyCrawl = studyCrawl;
