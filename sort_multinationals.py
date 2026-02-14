import json
import re

# 1. Define the input and output filenames
INPUT_FILE = 'emploitic_companies.json'
OUTPUT_FILE = 'multinational_companies_sorted.json'

# 2. Define keywords to identify known multinationals
# You can add more names to this list as needed.
MULTINATIONAL_KEYWORDS = [
    "Société Générale", "BNP Paribas", "Natixis", "Gulf Bank", "Bank ABC", "Al Baraka", "Arab Bank", "Fransabank", # Banks
    "Ooredoo", "Djezzy", "Huawei", "Siemens", "Ericsson", "Nokia", "ZTE", # Telecom/Tech
    "Samsung", "LG Electronics", "Condor", "Brandt", "Geant Electronics", # Electronics (Condor is local but large, usually listed)
    "Coca-Cola", "Pepsi", "Danone", "Nestlé", "Unilever", "Procter & Gamble", "Henkel", # FMCG
    "Sanofi", "Pfizer", "Hikma", "GlaxoSmithKline", "Novo Nordisk", "Roche", "AstraZeneca", "El Kendi", # Pharma
    "Total", "Shell", "Schlumberger", "Halliburton", "Baker Hughes", "General Electric", "Sonatrach", # Energy (Sonatrach is national but international scope)
    "Renault", "Peugeot", "Citroën", "Stellantis", "Volkswagen", "Toyota", "Hyundai", "Kia", "Fiat", # Automotive
    "Decathlon", "Carrefour", "Zara", "Mango", "Adidas", "Nike", "Azadea", # Retail
    "Marriott", "Sheraton", "Hilton", "Ibis", "Novotel", "Mercure", "Holiday Inn", # Hospitality
    "Maersk", "CMA CGM", "DHL", "FedEx", "UPS", "Swissport", "Lufthansa", "Emirates", # Logistics/Transport
    "KPMG", "Deloitte", "PwC", "Ernst & Young", "McKinsey" # Consulting
]

# 3. Define keywords that might indicate a foreign location (simple heuristic)
FOREIGN_COUNTRIES = [
    "France", "USA", "United States", "UK", "Royaume-Uni", "Germany", "Allemagne",
    "Spain", "Espagne", "Italy", "Italie", "China", "Chine", "Turkey", "Turquie",
    "UAE", "Dubai", "Qatar", "Saudi Arabia", "Arabie Saoudite", "Tunisia", "Tunisie",
    "Morocco", "Maroc", "Canada", "Belgium", "Belgique", "Switzerland", "Suisse"
]

def is_multinational(company):
    name = company.get('name', '').lower()
    location = company.get('location', '').lower()
    
    # Check if name contains any multinational keyword
    for keyword in MULTINATIONAL_KEYWORDS:
        if keyword.lower() in name:
            return True
            
    # Check if location contains a foreign country name (excluding "Algérie")
    # Note: Most multinationals in the file list their Algerian address, 
    # so the name check is the primary method.
    for country in FOREIGN_COUNTRIES:
        if country.lower() in location:
            return True
            
    return False

def sort_companies():
    try:
        # Load the JSON data
        with open(INPUT_FILE, 'r', encoding='utf-8') as f:
            companies = json.load(f)
            
        print(f"Loaded {len(companies)} companies.")

        # Filter the list
        multinationals = [comp for comp in companies if is_multinational(comp)]
        
        # Sort the filtered list by name
        multinationals_sorted = sorted(multinationals, key=lambda x: x.get('name', '').lower())

        # Save to a new file
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            json.dump(multinationals_sorted, f, indent=4, ensure_ascii=False)

        print(f"Found {len(multinationals_sorted)} multinational companies.")
        print(f"Successfully saved sorted list to '{OUTPUT_FILE}'.")

    except FileNotFoundError:
        print(f"Error: The file '{INPUT_FILE}' was not found. Please make sure it is in the same directory.")
    except json.JSONDecodeError:
        print(f"Error: Failed to decode JSON from '{INPUT_FILE}'.")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

if __name__ == "__main__":
    sort_companies()