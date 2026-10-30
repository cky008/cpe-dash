import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatBytesBinary,
  formatRateBitsPerSec,
  parseCaBandBanner,
  parseHostInfoJson,
  parseMcsEntries,
  parseNeighborCellsXml,
  parseNumberWithUnit,
  parseRfSignalSnapshot,
  parseSecondaryCellsXml,
  parseTrafficSnapshot,
  parseTxPowerMetrics,
  summarizeTopologyJson,
} from "../src/parsers.ts";

describe("RF, 3CA, MCS & Transmit Power Parsers", () => {
  it("parses numeric values with RF/frequency units and handles placeholders", () => {
    assert.equal(parseNumberWithUnit("-88dBm"), -88);
    assert.equal(parseNumberWithUnit("-7.5dB"), -7.5);
    assert.equal(parseNumberWithUnit("100MHz"), 100);
    assert.equal(parseNumberWithUnit("--"), null);
    assert.equal(parseNumberWithUnit(""), null);
    assert.equal(parseNumberWithUnit(undefined), null);
    assert.equal(parseNumberWithUnit("invalid"), null);
  });

  it("parses H168-383 3CA EN-DC band banner into structured component carriers", () => {
    const banner = "20MHz@100(B1) + 20MHz@1700(B3) + 100MHz@647424(N78)";
    const carriers = parseCaBandBanner(banner);
    assert.equal(carriers.length, 3);
    assert.deepEqual(carriers[0], {
      bandwidthMhz: 20,
      arfcn: 100,
      band: "B1",
      rat: "LTE",
    });
    assert.deepEqual(carriers[1], {
      bandwidthMhz: 20,
      arfcn: 1700,
      band: "B3",
      rat: "LTE",
    });
    assert.deepEqual(carriers[2], {
      bandwidthMhz: 100,
      arfcn: 647424,
      band: "N78",
      rat: "NR",
    });
    assert.deepEqual(parseCaBandBanner(""), []);
  });

  it("parses LTE and 5G NR MCS codeword strings including 256QAM", () => {
    const ulMcs = parseMcsEntries("mcsUpCarrier1:27@256QAM");
    assert.deepEqual(ulMcs, [
      { label: "mcsUpCarrier1", index: 27, modulation: "256QAM" },
    ]);

    const dlMcs = parseMcsEntries("mcsDownCarrier1Code0:11@64QAM mcsDownCarrier1Code1:11@64QAM");
    assert.equal(dlMcs.length, 2);
    assert.deepEqual(dlMcs[0], {
      label: "mcsDownCarrier1Code0",
      index: 11,
      modulation: "64QAM",
    });

    const nrDlMcs = parseMcsEntries("NRmcsDownCarrier1Code0:10@16QAM NRmcsDownCarrier1Code1:0");
    assert.deepEqual(nrDlMcs, [
      { label: "NRmcsDownCarrier1Code0", index: 10, modulation: "16QAM" },
      { label: "NRmcsDownCarrier1Code1", index: 0, modulation: null },
    ]);
    assert.deepEqual(parseMcsEntries(""), []);
  });

  it("parses PUSCH, PUCCH, SRS and PRACH transmit power telemetry", () => {
    const ltePower = parseTxPowerMetrics("PPusch:12dBm PPucch:-9dBm PSrs:0dBm PPrach:-3dBm");
    assert.deepEqual(ltePower, {
      puschDbm: 12,
      pucchDbm: -9,
      srsDbm: 0,
      prachDbm: -3,
    });
    assert.deepEqual(parseTxPowerMetrics(""), {
      puschDbm: null,
      pucchDbm: null,
      srsDbm: null,
      prachDbm: null,
    });
  });

  it("parses 8-column secondary component carrier CSV in /api/device/seccellinfo", () => {
    const secXml = `<?xml version="1.0" encoding="UTF-8"?>
<response>
  <lteseccell_list>1700,B3,20MHz,357,-84dBm,-8dB,-67dBm,12dB;</lteseccell_list>
  <nrseccell_list>647424,N78,100MHz,357,-93dBm,-10dB,-70dBm,8dB;</nrseccell_list>
</response>`;
    const parsed = parseSecondaryCellsXml(secXml);
    assert.equal(parsed.lteScc.length, 1);
    assert.equal(parsed.nrScc.length, 1);
    assert.deepEqual(parsed.lteScc[0], {
      rat: "LTE",
      arfcn: 1700,
      band: "B3",
      bandwidthMhz: 20,
      pci: 357,
      rsrpDbm: -84,
      rsrqDb: -8,
      rssiDbm: -67,
      sinrDb: 12,
    });
    assert.deepEqual(parsed.nrScc[0], {
      rat: "NR",
      arfcn: 647424,
      band: "N78",
      bandwidthMhz: 100,
      pci: 357,
      rsrpDbm: -93,
      rsrqDb: -10,
      rssiDbm: -70,
      sinrDb: 8,
    });
  });

  it("parses full RF snapshot, verifies hex/dec cell & TAC equivalence, and redacts raw location IDs", () => {
    // Synthetic RFC-safe CellID=134217758 (0x0800001E -> eNodeB=524288, sector=30), TAC=10001 (0x2711)
    const signalXml = `<response>
      <pci>357</pci>
      <cell_id>134217758</cell_id>
      <enodeb_id>0524288</enodeb_id>
      <tac>10001</tac>
      <rsrp>-88dBm</rsrp>
      <rsrq>-7.0dB</rsrq>
      <rssi>-70dBm</rssi>
      <sinr>8dB</sinr>
      <ulbandwidth>20MHz</ulbandwidth>
      <dlbandwidth>20MHz</dlbandwidth>
      <earfcn>DL:100 UL:18100</earfcn>
      <band>20MHz@100(B1) + 20MHz@1700(B3) + 100MHz@647424(N78)</band>
      <bandInfo>B1</bandInfo>
      <transmode>TM[4]</transmode>
      <cqi0>10</cqi0>
      <cqi1>11</cqi1>
      <ul_mcs>mcsUpCarrier1:27@256QAM</ul_mcs>
      <dl_mcs>mcsDownCarrier1Code0:11@64QAM mcsDownCarrier1Code1:11@64QAM</dl_mcs>
      <txpower>PPusch:12dBm PPucch:-9dBm PSrs:0dBm PPrach:-3dBm</txpower>
      <nrrsrp>-93dBm</nrrsrp>
      <nrrsrq>-10dB</nrrsrq>
      <nrsinr>8dB</nrsinr>
      <nrearfcn>DL:647424 UL:647424</nrearfcn>
      <nrulbandwidth>100MHz</nrulbandwidth>
      <nrdlbandwidth>100MHz</nrdlbandwidth>
      <nrulmcs>NRmcsUpCarrier1:17@64QAM</nrulmcs>
      <nrdlmcs>NRmcsDownCarrier1Code0:10@16QAM NRmcsDownCarrier1Code1:0</nrdlmcs>
      <nrtxpower>PPusch:23dBm PPucch:23dBm PSrs:0dBm PPrach:5dBm</nrtxpower>
      <nrrank>2</nrrank>
      <nrcqi0>12</nrcqi0>
      <nrcqi1>11</nrcqi1>
    </response>`;
    const secCellXml = `<response>
      <lteseccell_list>1700,B3,20MHz,357,-84dBm,-8dB,-67dBm,12dB;</lteseccell_list>
      <nrseccell_list>647424,N78,100MHz,357,-93dBm,-10dB,-70dBm,8dB;</nrseccell_list>
    </response>`;
    const riXml = `<response><ri>2</ri></response>`;
    const cellInfoXml = `<response><cellinfo>0800001E</cellinfo><lac>2711</lac></response>`;
    const plmnXml = `<response><FullName>Carrier-Lab</FullName><Numeric>27201</Numeric><Rat>7</Rat></response>`;

    const snap = parseRfSignalSnapshot({
      signalXml,
      secCellXml,
      riXml,
      cellInfoXml,
      plmnXml,
      redactIdentifiers: true,
    });

    assert.equal(snap.caActive, true);
    assert.equal(snap.caComponentCount, 3);
    assert.equal(snap.totalAggregatedBandwidthMhz, 140);
    assert.equal(snap.pccBand, "B1");
    assert.equal(snap.pci, 357);
    assert.equal(snap.lteMimoRank, 2);
    assert.equal(snap.nrMimoRank, 2);
    assert.equal(snap.transmissionMode, "TM[4]");
    assert.equal(snap.lteTxPower.puschDbm, 12);
    assert.equal(snap.nrTxPower.puschDbm, 23);
    assert.equal(snap.identityVerification.eciDecimalMatchesHex, true);
    assert.equal(snap.identityVerification.tacDecimalMatchesHex, true);
    assert.equal(snap.identityVerification.eNodeBDerivationMatchesTag, true);
    assert.equal(snap.cellIdDisplay, "<REDACTED:134217758>");
    assert.equal(snap.tacDisplay, "<REDACTED:10001>");
  });
});

describe("Neighbor Cell, Dual-Period Traffic & Terminal Topology Parsers", () => {
  it("parses 7-column 4G/5G neighbor cell CSV lists", () => {
    const nbrXml = `<response>
      <nbrcell_ltelist>1700,B3,357,-84dBm,-8dB,-67dBm,--;100,B1,25,-95dBm,-19dB,-67dBm,4dB;</nbrcell_ltelist>
      <nbrcell_nrlist>647424,N78,357,-93dBm,-10dB,-70dBm,8dB;</nbrcell_nrlist>
    </response>`;
    const parsed = parseNeighborCellsXml(nbrXml);
    assert.equal(parsed.lteNeighbors.length, 2);
    assert.equal(parsed.nrNeighbors.length, 1);
    assert.deepEqual(parsed.lteNeighbors[0], {
      rat: "LTE",
      arfcn: 1700,
      band: "B3",
      pci: 357,
      rsrpDbm: -84,
      rsrqDb: -8,
      rssiDbm: -67,
      sinrDb: null,
    });
    assert.equal(parsed.lteNeighbors[1]?.sinrDb, 4);
    assert.equal(parsed.nrNeighbors[0]?.band, "N78");
  });

  it("parses Today vs Monthly vs Total traffic accounting and formats binary units/rates", () => {
    const trafficXml = `<response>
      <CurrentConnectTime>3600</CurrentConnectTime>
      <CurrentUpload>104857600</CurrentUpload>
      <CurrentDownload>524288000</CurrentDownload>
      <CurrentDownloadRate>131072</CurrentDownloadRate>
      <CurrentUploadRate>65536</CurrentUploadRate>
      <TotalUpload>2000000000</TotalUpload>
      <TotalDownload>8000000000</TotalDownload>
      <TotalConnectTime>86400</TotalConnectTime>
    </response>`;
    const monthXml = `<response>
      <CurrentMonthDownload>1073741824</CurrentMonthDownload>
      <CurrentMonthUpload>536870912</CurrentMonthUpload>
      <MonthDuration>43200</MonthDuration>
      <MonthLastClearTime>2026-10-01</MonthLastClearTime>
      <CurrentDayUsed>268435456</CurrentDayUsed>
      <CurrentDayDuration>7200</CurrentDayDuration>
    </response>`;
    const startDateXml = `<response>
      <StartDay>1</StartDay>
      <DataLimit>500GB</DataLimit>
      <MonthThreshold>90</MonthThreshold>
    </response>`;

    const snap = parseTrafficSnapshot({ trafficXml, monthXml, startDateXml });
    assert.equal(snap.downloadBytesPerSec, 131072);
    assert.equal(snap.downloadBps, 1048576);
    assert.equal(snap.uploadBps, 524288);
    assert.equal(snap.todayUsedBytes, 268435456n);
    assert.equal(snap.monthTotalBytes, 1610612736n);
    assert.equal(snap.totalUsedBytes, 10000000000n);
    assert.equal(snap.billingStartDay, 1);
    assert.equal(snap.dataLimitRaw, "500GB");
    assert.equal(snap.monthThresholdPercent, 90);

    assert.equal(formatBytesBinary(512), "512 B");
    assert.equal(formatBytesBinary(2048), "2.00 KiB");
    assert.equal(formatBytesBinary(268435456n), "256.00 MiB");
    assert.equal(formatBytesBinary(1610612736n), "1.50 GiB");
    assert.equal(formatBytesBinary(2199023255552n), "2.00 TiB");

    assert.equal(formatRateBitsPerSec(500), "500.00 bps");
    assert.equal(formatRateBitsPerSec(524288), "512.00 Kbps");
    assert.equal(formatRateBitsPerSec(1048576), "1.00 Mbps");
    assert.equal(formatRateBitsPerSec(2147483648), "2.00 Gbps");
  });

  it("parses and classifies HostInfo JSON terminals with strict MAC/IPv6/hostname masking", () => {
    const rawHostJson = JSON.stringify([
      {
        MACAddress: "AA:BB:CC:DD:EE:01",
        HostName: "Real-Synology-NAS",
        ActualName: "DS923Plus",
        IPAddress: "192.168.8.10",
        IPv6Address: "fe80::1234;2001:db8::99",
        V6Active: true,
        Active: true,
        InterfaceType: "Ethernet",
        Layer2Interface: "LAN1",
        Frequency: "",
        PhyType: 1000,
        EthernetSpeed: 1000,
        rate: 0,
        rssi: 0,
        AddressSource: "STATIC",
        LeaseTime: 0,
        AssociatedTime: 90000,
      },
      {
        MACAddress: "AA:BB:CC:DD:EE:02",
        HostName: "Real-Phone",
        ActualName: "",
        IPAddress: "192.168.8.55",
        IPv6Address: "fe80::abcd",
        V6Active: true,
        Active: true,
        InterfaceType: "Wireless",
        Layer2Interface: "SSID7",
        Frequency: "5GHz_1",
        PhyType: 0,
        EthernetSpeed: 0,
        rate: 2402,
        rssi: 78,
        AddressSource: "DHCP",
        LeaseTime: 43200,
        AssociatedTime: 1800,
      },
      {
        MACAddress: "AA:BB:CC:DD:EE:03",
        HostName: "IoT-Sensor",
        ActualName: "",
        IPAddress: "192.168.8.88",
        IPv6Address: "",
        V6Active: false,
        Active: true,
        InterfaceType: "Wireless",
        Layer2Interface: "SSID1",
        Frequency: "2.4GHz",
        EthernetSpeed: 0,
        rate: 144,
        rssi: 65,
        AddressSource: "DHCP",
        LeaseTime: 81000,
        AssociatedTime: 3600,
      },
    ]);

    const hosts = parseHostInfoJson(rawHostJson);
    assert.equal(hosts.length, 3);
    assert.equal(hosts[0]?.macAddress, "00:00:5E:00:53:01");
    assert.equal(hosts[0]?.displayName, "lan-client-01");
    assert.equal(hosts[0]?.medium, "LAN_1000M");
    assert.equal(hosts[0]?.negotiatedRateMbps, 1000);
    assert.deepEqual(hosts[0]?.ipv6Addresses, ["fe80::1", "2001:db8::99"]);

    assert.equal(hosts[1]?.medium, "WIFI_5G");
    assert.equal(hosts[1]?.negotiatedRateMbps, 2402);
    assert.equal(hosts[1]?.leaseTimeRemainingSec, 43200);

    assert.equal(hosts[2]?.medium, "WIFI_2_4G");
    assert.deepEqual(parseHostInfoJson("not-json"), []);

    const rawTopoJson = JSON.stringify([
      {
        Active: true,
        AccessType: "Ethernet",
        HiLinkType: "Device",
        ConnectedDevices: [
          { Active: true, AccessType: "Wireless", ConnectedDevices: [] },
        ],
      },
      {
        Active: true,
        AccessType: "Wireless",
        HiLinkType: "None",
        ConnectedDevices: [],
      },
    ]);
    const summary = summarizeTopologyJson(rawTopoJson);
    assert.equal(summary.topLevelNodes, 2);
    assert.equal(summary.totalActiveNodes, 3);
    assert.equal(summary.meshChildNodes, 1);
    assert.equal(summary.ethernetNodes, 1);
    assert.equal(summary.wirelessNodes, 2);
    assert.equal(summarizeTopologyJson("bad").totalActiveNodes, 0);
  });
});
