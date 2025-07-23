const fs = require('node:fs/promises');
const { createWriteStream, createReadStream } = require('node:fs')
const { Readable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { argv } = require('node:process');
const { createHash } = require('node:crypto');

const bestanden = [];
const APIROOT="https://omgevingsloketinzage.omgeving.vlaanderen.be/proxy-omv-up/rs/v1/"

async function request(pad, options = {}) {
    const url = APIROOT + pad
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            throw `request error ${response.status}: ${await response.text()}`
        }
        return await response.json()
    } catch(e) {
        throw new Error(`Fetch failed for ${url}`, {cause: e})
    }
}

async function md5Match(pad, sum) {
    try {
        const hash = createHash("md5");
        const stream = createReadStream(pad);
        for await (const chunk of stream) {
            hash.update(chunk);
        } 
        return hash.digest().equals(sum);
    } catch (e) {
        return false;
    }
}

async function downloadBestand(werkPad, f) {
    const pad = werkPad.concat([f.bestandsnaam]).join('/');
    if (! await(md5Match(pad, Buffer.from(f.hash, 'base64')))) {
        console.debug(`download ${pad}`)
        await fs.mkdir(werkPad.join('/'), {recursive: true});
        const url = `${APIROOT}inzage/bestanden/${f.uuid}/download`;
        const response = await fetch(url);
        if (!response.ok) {
            throw `request error for ${url} ${response.status}: ${await response.text()}`
        }
        await finished(
            Readable.fromWeb(response.body).pipe(createWriteStream(pad, {flags: 'w'}))
        )
    }
    bestanden.push(`${pad} (${f.datumOpladen.join('/')}): ${f.omschrijving || ""}`);
}

async function downloadStukken(werkPad, onderdeel) {
    if (onderdeel.dossierstukUuid) {
        const pad = werkPad.concat([onderdeel.dossierstuk.code]);
        const stukken = await request(`inzage/dossierstukken/${onderdeel.dossierstukUuid}/bestanden?size=1000`)
        await Promise.all(stukken.content.map(s => downloadBestand(pad, s)));
    }
    if (onderdeel.subOnderdelen) {
        const pad = werkPad.concat([onderdeel.codelijstMetCategorie.code]);
        await Promise.all(onderdeel.subOnderdelen.map(subOnderdeel => downloadStukken(pad, subOnderdeel)))
    } 
}

async function downloadOnderdeel(werkPad, onderdeel) {
    const pad = werkPad.concat([onderdeel.inhoud.aard.code])
    const details = await request(`inzage/dossier-onderdelen/${onderdeel.uuid}/details`)
    await Promise.all(details.details.map(detail => downloadStukken(pad, detail)))
}

async function downloadVoorwerp(werkPad, voorwerp) {
    const uuid = voorwerp.uuid;
    const pad = werkPad.concat(voorwerp.betreft); 
    const plannenFotos = await request(`inzage/voorwerpen/${uuid}/plannen-en-fotos?size=1000`, {
        method: 'POST',
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({filters:[]})
    });
    await Promise.all(plannenFotos.content.map(pf => downloadBestand(pad, pf)));

    const onderdelen = await request(`inzage/voorwerpen/${uuid}/onderdelen`);
    await Promise.all(onderdelen.map(o => downloadOnderdeel(pad, o)));

    const stukken = await request(`inzage/voorwerpen/${uuid}/dossierstukken`);
    for(const stuk of stukken) {
        const stukPad = pad.concat(stuk.dossierstukType.code);
        const bestanden = await request(`inzage/dossierstukken/${stuk.uuid}/bestanden?size=1000`)
        await Promise.all(bestanden.content.map(s => downloadBestand(stukPad, s)));
    }
}
async function downloadGebeurtenis(werkPad, gebeurtenis) {
    const pad = werkPad.concat(gebeurtenis.gevraagdAan || gebeurtenis.verantwoordelijke)
    const inhoud = await request(`inzage/gebeurtenissen/${gebeurtenis.uuid || gebeurtenis.adviesVraagGebeurtenisUuid}`)
    for (const onderdeel of inhoud) {
        for(const bestand of onderdeel.bestanden) {
            await downloadBestand(pad.concat(onderdeel.titel), bestand)
        }
    }
}

async function downloadProcedure(werkPad, uuid) {
    const procedure = await request(`inzage/projecten/${uuid}/procedure`);
    for (const stap of procedure) {
        const pad = werkPad.concat(stap.inhoud.aard.code)
        const adviezen = await request(`inzage/projectfasen/${stap.uuid}/advies-gebeurtenissen?size=1000`)
        for(const gebeurtenis of adviezen.content) {
            await downloadGebeurtenis(pad.concat("adviezen"), gebeurtenis)
        }
        const beslissingen = await request(`inzage/projectfasen/${stap.uuid}/beslissing-gebeurtenissen?size=1000`)
        for(const gebeurtenis of beslissingen.content) {
            await downloadGebeurtenis(pad.concat("beslissing"), gebeurtenis)
        }
        const gebeurtenissen = await request(`inzage/projectfasen/${stap.uuid}/andere-gebeurtenissen?size=1000`)
        for(const gebeurtenis of gebeurtenissen.content) {
            await downloadGebeurtenis(pad.concat("gebeurtenissen"), gebeurtenis)
        }
    }
}

async function download(projectId) {
    const header = await request(`inzage/projecten/header?projectnummer=${projectId}`);
    const pad = [projectId]

    const projectInfo = await request(`inzage/projecten/${header.uuid}/projectinformatie`);
    const topVoorwerpen = await request(`inzage/projecten/${header.uuid}/top-voorwerpen?size=1000`);
    await Promise.all(topVoorwerpen.content.map(v => downloadVoorwerp(pad, v)));
    await downloadProcedure(pad, header.uuid)

    const downloadLog = await fs.open(`${projectId}/inhoud.txt`, 'w');
    await downloadLog.write(`# ${projectId}: ${header.projectnaam}\n`)
    await downloadLog.write(`## automatisch gegenereerd met https://github.com/steven-aerts/omvdownloader ${projectId} op ${new Date()}\n\n## Bestanden:\n`)
    await downloadLog.write(bestanden.sort().join('\n'));
}

(async () => {
    if (argv.length != 3) {
        throw `${argv[0]} moet opgeroepen worden met OMV nummer als enige argument.`
    }
    var omvValid = argv[2].match(/^(OMV_)?([0-9]{10})$/);
    if (!omvValid) {
        throw `Ongekend formaat voor OMV nummer: ${argv[2]}`
    }
    await download(`OMV_${omvValid[2]}`);
})().catch(e => {
    console.error(e)
})
