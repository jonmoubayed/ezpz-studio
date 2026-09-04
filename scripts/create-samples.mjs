import {PDFDocument,StandardFonts,rgb} from 'pdf-lib'
import {mkdir,writeFile} from 'node:fs/promises'
await mkdir('public/samples',{recursive:true})
const vendors=['Northstar Design Co.','Acme Software Inc.','Linear Supply Co.','Meridian Studio','Atlas Office Goods','Forma Creative']
for(let i=0;i<6;i++){
 const pdf=await PDFDocument.create();const page=pdf.addPage([612,792]);const font=await pdf.embedFont(StandardFonts.Helvetica);const bold=await pdf.embedFont(StandardFonts.HelveticaBold);const ink=rgb(.15,.19,.18);const gray=rgb(.48,.52,.5);const green=rgb(.20,.40,.32)
 const text=(t,x,y,size=11,strong=false,color=ink)=>page.drawText(t,{x,y:792-y,size,font:strong?bold:font,color});const line=(y)=>page.drawLine({start:{x:55,y:792-y},end:{x:557,y:792-y},color:rgb(.85,.88,.86),thickness:.6})
 text(vendors[i],55,92,23,true);text('Thoughtful work. Lasting impact.',55,115,10,false,gray);text('INVOICE',411,72,10,true,green);text(`INV-2026-00${i+1}`,398,131,12,true);text('ISSUED',398,160,8,true,gray);text('September 1, 2026',398,186);text('DUE DATE',398,213,8,true,gray);text('September 30, 2026',398,234)
 text('FROM',55,161,8,true,gray);text(vendors[i],55,182,11,true);text('1220 Pacific Avenue',55,199);text('San Francisco, CA 94103',55,216);text('hello@northstar.example',55,233,10,false,gray)
 line(267);text('BILL TO',55,296,8,true,gray);text('Evergreen Technologies',55,320,13,true);text('Attn: Accounts Payable',55,339,10);text('445 Market Street, San Francisco, CA 94105',55,357,10,false,gray)
 page.drawRectangle({x:55,y:792-410,width:502,height:28,color:rgb(.94,.96,.94)});text('DESCRIPTION',67,401,8,true,gray);text('QTY',355,401,8,true,gray);text('RATE',410,401,8,true,gray);text('AMOUNT',490,401,8,true,gray)
 const base=2400+i*180;text('Design & consulting services',67,436,11,true);text('September project engagement',67,453,9,false,gray);text('24',357,436,10);text(`$${(base/24).toFixed(2)}`,410,436,10);text(`$${base.toFixed(2)}`,489,436,10);line(479)
 text('Subtotal',370,527,10,false,gray);text(`$${base.toFixed(2)}`,490,527,11);text('Tax (8%)',370,559,10,false,gray);text(`$${(base*.08).toFixed(2)}`,490,559,11)
 page.drawRectangle({x:357,y:792-620,width:200,height:42,color:rgb(.91,.95,.92)});text('Amount due',370,605,11,true,green);text(`$${(base*1.08).toFixed(2)}`,478,605,15,true,green)
 text('THANK YOU FOR YOUR BUSINESS',55,672,8,true,gray);text('Please include the invoice number with your payment.',55,692,10,false,gray);line(727);text('Demo document generated for ezpz studio. No real transaction.',55,748,8,false,gray)
 await writeFile(`public/samples/invoice-${i}.pdf`,await pdf.save())
}
