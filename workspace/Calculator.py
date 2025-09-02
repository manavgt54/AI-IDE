# Calculator Application
# Created automatically by the IDE

def add(x, y):
    return x + y

def subtract(x, y):
    return x - y

def multiply(x, y):
    return x * y

def divide(x, y):
    if y == 0:
        return "Error: Cannot divide by zero"
    return x / y

def calculator():
    print("=== Calculator ===")
    print("Operations: +, -, *, /")
    print("Type 'quit' to exit")
    
    while True:
        try:
            user_input = input("\nEnter calculation (e.g., 5 + 3): ").strip()
            
            if user_input.lower() == 'quit':
                print("Goodbye!")
                break
            
            if '+' in user_input:
                parts = user_input.split('+')
                if len(parts) == 2:
                    result = add(float(parts[0].strip()), float(parts[1].strip()))
                    print(f"Result: {{result}}")
                else:
                    print("Invalid format. Use: number + number")
            
            elif '-' in user_input:
                parts = user_input.split('-')
                if len(parts) == 2:
                    result = subtract(float(parts[0].strip()), float(parts[1].strip()))
                    print(f"Result: {{result}}")
                else:
                    print("Invalid format. Use: number - number")
            
            elif '*' in user_input:
                parts = user_input.split('*')
                if len(parts) == 2:
                    result = multiply(float(parts[0].strip()), float(parts[1].strip()))
                    print(f"Result: {{result}}")
                else:
                    print("Invalid format. Use: number * number")
            
            elif '/' in user_input:
                parts = user_input.split('/')
                if len(parts) == 2:
                    result = divide(float(parts[0].strip()), float(parts[1].strip()))
                    print(f"Result: {{result}}")
                else:
                    print("Invalid format. Use: number / number")
            
            else:
                print("Invalid operation. Supported: +, -, *, /")
                
        except ValueError:
            print("Invalid input. Please enter valid numbers.")
        except KeyboardInterrupt:
            print("\nGoodbye!")
            break
        except Exception as e:
            print(f"Error: {{e}}")

if __name__ == "__main__":
    calculator()