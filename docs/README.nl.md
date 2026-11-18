# OpenChamber Kubernetes Explorer

[English](../README.md) | [简体中文](README.zh-CN.md) | [العربية](README.ar.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [עברית](README.he.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | Nederlands | [Polski](README.pl.md) | [Português (Brasil)](README.pt-BR.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [繁體中文](README.zh-TW.md)

Een Kubernetes-extensie voor OpenChamber. Verken clusters, onderzoek problemen met workloads en voer gangbare Kubernetes-bewerkingen uit zonder de werkruimte van je project te verlaten.

## Installatie

Zodra de voorgebouwde extensiebestanden in de standaardbranch van de repository zijn gepubliceerd:

1. Open **Instellingen → Extensies** in OpenChamber.
2. Plak de URL van de repository in **Map, ZIP of URL** en klik op **Toevoegen**:

   ```text
   https://github.com/hlhr202/Openchamber-Kubernetes
   ```

3. Controleer en verleen de gevraagde toegang tot de lokale service. Open daarna **Kubernetes** vanuit de extensiebalk.

Lokaal bouwen of JavaScript-afhankelijkheden installeren is niet nodig. Zolang de repository privé is, moet OpenChamber Server al beschikken over Git-inloggegevens waarmee de repository via HTTPS kan worden gelezen. Aanmelden bij GitHub in je browser geeft de server die inloggegevens niet.

De [in Docker geverifieerde kandidaatversie](status.md) biedt ook een voorgebouwd ZIP-bestand voor handmatige installatie. Installatie via een Git-URL is nog niet geverifieerd.

## Vereisten

- **OpenChamber 2.5.1**, de versie waarvoor de extensie is bedoeld.
- Een werkende **kubeconfig** die beschikbaar is voor de gebruiker van het besturingssysteem waaronder OpenChamber Server draait, met netwerktoegang tot de Kubernetes-API en de vereiste machtigingen.
- **`kubectl`** moet op de server beschikbaar zijn. Voor bewerkingen die de Helm-CLI aanroepen is **Helm** nodig. Als je kubeconfig een extern programma voor inloggegevens gebruikt, moet dat ook op de server beschikbaar zijn. De extensie installeert deze hulpmiddelen niet.

## Functies

- Wissel tussen Kubernetes-contexten en namespaces en bekijk workloads, services en aangepaste resources in een boomstructuur.
- Bekijk manifesten, lees Pod-logs en bekijk gebeurtenissen in namespaces.
- Controleer wijzigingen in manifesten en pas ze expliciet toe op het geselecteerde doel.
- Open een terminal in de geselecteerde container of stel poortdoorsturing in.
- Bekijk Helm-repositories, charts, releases en revisiegeschiedenis.

## Wat de auteur heeft getest

De auteur heeft zelf slechts vier handelingen getest: resourcelijsten uitklappen in de boomstructuur, resourcedetails bekijken, een containerterminal gebruiken en poorten doorsturen. Heb je vragen of loop je tegen problemen aan bij andere handelingen? [Open gerust een issue op GitHub](https://github.com/hlhr202/Openchamber-Kubernetes/issues).

## Privacy

- De extensie stuurt geen telemetrie of analysegegevens naar de ontwikkelaars. Ze gebruikt de kubeconfig op de server en je bestaande rechten om verbinding te maken met de ingestelde Kubernetes-API.
- Opgehaalde resourcegegevens, logs, terminaluitvoer en niet-opgeslagen concepten blijven in het geheugen en worden niet naar schijf geschreven. Niet-gevoelige voorkeuren, zoals de gekozen kubeconfig-bronnen, worden bewaard; de inhoud van kubeconfig-bestanden niet. Expliciet opslaan of exporteren zijn afzonderlijke handelingen.
- Waarden van Secrets worden alleen op verzoek getoond, voor zover je Kubernetes-machtigingen dat toelaten. Clustergegevens worden niet automatisch naar de chat of een modelaanbieder gestuurd.

Deze verklaring geldt voor de extensie, niet voor OpenChamber, Kubernetes of de externe hulpmiddelen en diensten die je gebruikt.

## Licentie

[MIT](../LICENSE). Meegeleverde afhankelijkheden behouden hun eigen licenties. Zie `THIRD_PARTY_NOTICES.txt` in het voorgebouwde pakket.

[Projectdocumentatie](README.md) · [Reikwijdte](product.md) · [Ontwikkeling](development.md)
