<#  Hospital Pharmacy - print a PDF straight to a printer, with no print window (release 1.20).

    The app's server (platform/printing.ts) makes the PDF from the labels or the document with Microsoft Edge, then runs
    this: every page is drawn by Windows' own PDF renderer (Windows.Data.Pdf) at the printer's resolution and sent to
    the printer at the page's real size - a label edge to edge on its roll, a document on A4.

    -Printer   the Windows printer's name
    -Pdf       the PDF to print
    -Dpi       resolution to draw the pages at (label printers 203 or 300; documents 200)
    -A4        print on the printer's A4 paper (documents); otherwise on a paper the size of the PDF's pages (labels)
    -ToFile    (tests) write the printer's output to this file instead of printing
    -RenderTo  (tests) only draw the pages, as page-1.png … in this folder, and print nothing
#>
[CmdletBinding()] param(
  [string]$Printer,
  [Parameter(Mandatory)][string]$Pdf,
  [int]$Dpi = 300,
  [switch]$A4,
  [string]$ToFile,
  [string]$RenderTo
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# ---- the PDF's pages as pictures (Windows.Data.Pdf: part of Windows 10 and 11)
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$ext = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOf = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
$asTask = $ext | Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function Await($op, [Type]$type) { $t = $asTaskOf.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(60000); if (-not $t.IsCompleted) { throw 'Windows did not open the PDF in time' }; $t.Result }
function AwaitAction($op) { $t = $asTask.Invoke($null, @($op)); [void]$t.Wait(60000); if (-not $t.IsCompleted) { throw 'Windows did not draw the page in time' } }

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path -LiteralPath $Pdf).Path)) ([Windows.Storage.StorageFile])
$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
if ($doc.PageCount -lt 1) { throw 'The PDF has no pages' }
$pages = New-Object System.Collections.Generic.List[System.Drawing.Image]
$sizesIn = New-Object System.Collections.Generic.List[object]   # each page's size in inches
for ($i = 0; $i -lt $doc.PageCount; $i++) {
  $page = $doc.GetPage([uint32]$i)
  try {
    $wIn = $page.Size.Width / 96.0; $hIn = $page.Size.Height / 96.0       # PdfPage.Size is in 1/96 inch
    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = [uint32][Math]::Round($wIn * $Dpi)
    $opts.DestinationHeight = [uint32][Math]::Round($hIn * $Dpi)
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    AwaitAction ($page.RenderToStreamAsync($stream, $opts))
    $stream.Seek(0)
    $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
    $mem = New-Object System.IO.MemoryStream
    $net.CopyTo($mem); $mem.Position = 0
    $img = [System.Drawing.Image]::FromStream($mem)
    $pages.Add($img); $sizesIn.Add(@($wIn, $hIn))
  } finally { $page.Dispose() }
}

if ($RenderTo) {
  New-Item -ItemType Directory -Force -Path $RenderTo | Out-Null
  for ($i = 0; $i -lt $pages.Count; $i++) { $pages[$i].Save((Join-Path $RenderTo ("page-{0}.png" -f ($i + 1))), [System.Drawing.Imaging.ImageFormat]::Png) }
  Write-Output ("drew {0} page(s), {1} x {2} px" -f $pages.Count, $pages[0].Width, $pages[0].Height)
  foreach ($p in $pages) { $p.Dispose() }
  exit 0
}
if (-not $Printer) { throw 'Say which printer to print on (-Printer)' }

# ---- to the printer
$pd = New-Object System.Drawing.Printing.PrintDocument
$pd.PrinterSettings.PrinterName = $Printer
if (-not $pd.PrinterSettings.IsValid) { throw "There is no printer called '$Printer' on this PC" }
$pd.DocumentName = 'Hospital Pharmacy'
$pd.PrintController = New-Object System.Drawing.Printing.StandardPrintController   # no "Printing page 1 of 1" window
$pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
$first = $sizesIn[0]
$landscape = $first[0] -gt $first[1]
if ($A4) {
  $a4 = $pd.PrinterSettings.PaperSizes | Where-Object { $_.Kind -eq [System.Drawing.Printing.PaperKind]::A4 } | Select-Object -First 1
  if ($a4) { $pd.DefaultPageSettings.PaperSize = $a4 } else { $pd.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('A4', 827, 1169) }
  $pd.DefaultPageSettings.Landscape = $landscape
} else {
  # a paper the size of the label (hundredths of an inch), never turned
  $pd.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('Hospital Pharmacy label', [int][Math]::Round($first[0] * 100), [int][Math]::Round($first[1] * 100))
  $pd.DefaultPageSettings.Landscape = $false
}
if ($ToFile) { $pd.PrinterSettings.PrintToFile = $true; $pd.PrinterSettings.PrintFileName = $ToFile }
$script:n = 0
$pd.add_PrintPage({
  param($sender, $e)
  $img = $pages[$script:n]
  $g = $e.Graphics
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  # from the paper's own corner: the printer's unprintable edge is not added to the design (labels are edge to edge)
  $g.TranslateTransform(-$e.PageSettings.HardMarginX, -$e.PageSettings.HardMarginY)
  $g.DrawImage($img, 0, 0, $e.PageBounds.Width, $e.PageBounds.Height)
  $script:n++
  $e.HasMorePages = $script:n -lt $pages.Count
})
try { $pd.Print() } finally { foreach ($p in $pages) { $p.Dispose() } }
Write-Output ("printed {0} page(s) on {1}" -f $pages.Count, $Printer)
