import { Octokit } from "octokit";
import fs from "fs/promises";
import Filter from "bad-words";
import iso6391 from 'iso-639-1';
import 'dotenv/config';

const DB_FILENAME = "data.json";
const MINIFIED_FILENAME = "data.min.json";
const APP_NAME = "ViSingersBot";

const VOICEBANK_TYPES = [
    "utau",
    "paintvoice",
    "diffsinger",
    "rvc",
    "freeloid",
    "vocalsharp",
    "niaoniao",
    "deepvocal",
    "nnsvs"
];

const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:(?:youtube\.com\/watch\?v=)|(?:youtu\.be\/))([a-zA-Z0-9_-]{11})/g;

const GET_REPO_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: "HEAD:") {
      ... on Tree {
        entries {
          name
          type
          path
          object {
            ... on Blob {
              text
              byteSize
            }
          }
        }
      }
    }
  }
}
`;

const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
    userAgent: `${APP_NAME}/1.0`
});

const filter = new Filter();

function censorText(text) {
    if (!text) return "";
    try { return filter.clean(text); } catch (e) { return text; }
}

function getSections(rows) {
    const sections = [];
    let sectionName = "";
    let content = [];
    for (const row of rows) {
        if (row.trim().startsWith("#")) {
            if (sectionName) sections.push({ name: sectionName, content: [...content] });
            
            let rawName = row.replace(/^#+/, "").split("[!")[0].trim();
            sectionName = rawName.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
            
            content = [];
        } else if (sectionName) {
            content.push(row);
        }
    }
    if (content.length !== 0) sections.push({ name: sectionName, content: [...content] });
    return sections;
}

function getLanguagesList() {
    const allCodes = iso6391.getAllCodes();
    const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
    return allCodes.map(code => {
        try {
            const fullName = displayNames.of(code);
            return { name: code, fullName: fullName.toLowerCase() };
        } catch (e) { return null; }
    }).filter(item => item !== null);
}

async function main() {
    console.log("Starting GitHub Parser...");
    const languages = getLanguagesList();
    const resultSingers = [];
    const reservedNames = ["videos", "groups", "terms of use", "general info"];

    try {
        const response = await octokit.rest.search.repos({
            q: "topic:visingers",
            sort: "updated",
            per_page: 100
        });

        for (const repo of response.data.items) {
            if (repo.name.includes("template")) continue;

            const graphqlResult = await octokit.graphql(GET_REPO_QUERY, {
                owner: repo.owner.login,
                name: repo.name
            });

            const entries = graphqlResult.repository?.object?.entries || [];
            const files = entries.map(entry => ({
                name: entry.name,
                type: entry.type,
                path: entry.path,
                text: entry.type === "blob" ? entry.object.text : null
            }));

            const readmeFile = files.find(f => f.name.toLowerCase() === "readme.md");
            if (!readmeFile || !readmeFile.text) continue;

            const sections = getSections(censorText(readmeFile.text).split(/\r?\n/));
            if (sections.length === 0) continue;

            const descriptionSection = sections[0];
            const voicebanks = [];
            const downloadUrlRegex = new RegExp(`^https://github\\.com/${repo.owner.login}/${repo.name}/releases/download/`, 'i');

            for (let i = 1; i < sections.length; i++) {
                const s = sections[i];
                if (reservedNames.includes(s.name.toLowerCase())) continue;

                const langRow = s.content.find(r => r.toLowerCase().includes("languages:"));
                const typeRow = s.content.find(r => r.toLowerCase().includes("type:"));

                if (!typeRow || !langRow) continue;

                const parsedTypeStr = typeRow.split(":")[1]?.trim().toLowerCase();
                const type = VOICEBANK_TYPES.find(t => t === parsedTypeStr);

                if (!type) continue;

                const parsedLangs = langRow.split(":")[1].split(",").map(l => l.trim().toLowerCase());
                const vbLanguages = languages
                    .filter(l => parsedLangs.includes(l.name) || parsedLangs.includes(l.fullName))
                    .map(l => l.name);

                const releases = (await octokit.rest.repos.listReleases({ owner: repo.owner.login, repo: repo.name })).data;
                let lastRelease = releases.filter(r => r.name.startsWith(s.name))[0] || (sections.filter(sec => !reservedNames.includes(sec.name.toLowerCase())).length === 1 ? releases[0] : null);

                if (!lastRelease) continue;

                const zipAsset = lastRelease.assets.find(a => a.name.endsWith(".zip"));
                if (!zipAsset) continue;

                voicebanks.push({
                    name: s.name,
                    type: type,
                    languages: vbLanguages,
                    url: zipAsset.browser_download_url.replace(downloadUrlRegex, ""),
                    sampleUrls: lastRelease.assets
                        .filter(a => a.name.endsWith(".mp3") || a.name.endsWith(".wav"))
                        .map(a => a.browser_download_url.replace(downloadUrlRegex, "")),
                    description: { "en": s.content.filter(r => !r.trim().startsWith("-")).join("\n").trim() }
                });
            }

            if (voicebanks.length > 0) {
                resultSingers.push({
                    id: repo.id,
                    name: descriptionSection.name,
                    repositoryName: repo.name,
                    voicebanks: voicebanks,
                    updatedAt: repo.updated_at,
                    stars: repo.stargazers_count
                });
            }
        }

        await fs.writeFile(DB_FILENAME, JSON.stringify({ singers: resultSingers }, null, 2));
        console.log(`Success! Found ${resultSingers.length} singers.`);
    } catch (e) {
        console.error(e);
    }
}

main();
