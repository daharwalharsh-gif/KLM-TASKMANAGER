/**
 * KLM Task Manager — FMS Image/PDF upload → Google Drive folder
 *
 * SETUP (ek baar, ~2 minute):
 *  1. https://script.google.com kholo (USI Google account se jo Drive folder ka owner hai)
 *  2. "New project" → ye poora code paste karo → Save (naam: KLM Drive Upload)
 *  3. Deploy → New deployment → type: "Web app"
 *       - Execute as:      Me
 *       - Who has access:  Anyone
 *  4. Authorize karo (apna account chuno → Advanced → Go to KLM Drive Upload → Allow)
 *  5. Jo "Web app URL" mile (https://script.google.com/macros/s/.../exec) — wo copy karke do
 *
 * Server isko POST karta hai: { filename, mimeType, dataBase64 }
 * Ye folder me file save karke { success, link, fileId } return karta hai.
 */

var FOLDER_ID = '1qXC1QGafRf1QZ2R5WCZPbghb46zvx4xV';

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!body.dataBase64) throw new Error('dataBase64 missing');

    var mt = String(body.mimeType || 'application/octet-stream').toLowerCase();
    if (mt.indexOf('image/') !== 0 && mt !== 'application/pdf') throw new Error('Sirf image ya PDF allowed hai');

    var bytes = Utilities.base64Decode(body.dataBase64);
    var blob = Utilities.newBlob(bytes, mt, body.filename || ('file_' + Date.now()));

    var folder = DriveApp.getFolderById(FOLDER_ID);
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, link: file.getUrl(), fileId: file.getId() }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: String(err && err.message || err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
